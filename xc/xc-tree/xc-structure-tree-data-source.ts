/*
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * Copyright 2023 Xyna GmbH, Germany
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 */
import { Observable, Subject } from 'rxjs';

import { I18nService } from '@zeta/i18n';

import { ApiService, FullQualifiedName, RuntimeContext, Xo, XoArray, XoDescriber, XoDescriberCache, XoObject, XoStructureArray, XoStructureField, XoStructureObject, XoStructurePrimitive, XoStructureType } from '../../api';
import { Comparable, defineAccessorProperty } from '../../base/base';
import { XcAutocompleteDataWrapper } from '../xc-form/xc-form-autocomplete/xc-form-autocomplete.component';
import { FloatStyle } from '../xc-form/xc-form-base/xc-form-base.component';
import { XcCheckboxTemplate, XcDataTemplate, XcFormAutocompleteTemplate, XcFormTemplate, XcIconButtonTemplate, XcTemplate } from '../xc-template/xc-template';
import { XcTemplateFactory } from '../xc-template/xc-template-factory';
import { XcBaseStructureTreeDataSource } from './xc-base-structure-tree-data-source';
import { XcTreeNode } from './xc-tree-data-source';


class ComparableDescriber extends Comparable implements XoDescriber {

    constructor(readonly rtc: RuntimeContext, readonly fqn: FullQualifiedName) {
        super();
    }

    get uniqueKey(): string {
        return (this.rtc ? this.rtc.uniqueKey : '<no RTC>') + '/' + (this.fqn ? this.fqn.uniqueKey : '<no FQN>');
    }
}


export class XcStructureTreeDataSource extends XcBaseStructureTreeDataSource {

    private static readonly ICON_NAME_ADD = 'add';
    private static readonly ICON_NAME_DELETE = 'delete';

    subtypesCache = new XoDescriberCache<XoStructureType>();

    /**
     * Determines the limit of array types
     */
    arrayTypesLimit = 5;

    /**
     * Controls the type editability of complex objects
     */
    complexTypesReadonly = false;

    private readonly _contentChangeSubject = new Subject<void>();


    constructor(apiService: ApiService, i18n: I18nService, rtc: RuntimeContext, describers: XoDescriber[], container?: XoArray, translateLabels: boolean = true) {
        super(apiService, i18n, rtc, describers, container ? container : new XoArray(), translateLabels);
    }


    protected createNodeFromField(field: XoStructureField, parent: XcTreeNode): XcTreeNode {
        const node = super.createNodeFromField(field, parent);

        const templates = this.getTemplates(field, node);

        // wrap template-setters to trigger content-change-subject
        templates.filter(template => template instanceof XcDataTemplate).forEach(template => {
            const dataTemplate: XcDataTemplate<any, any> = template as XcDataTemplate<any, any>;

            const setter = dataTemplate.dataWrapper.setter;
            const getter = dataTemplate.dataWrapper.getter;
            const dataChangeSetter = (value: any): void => {
                // explicitly don't match with triple-equals to not consider string -> number (>>"123" -> 123<<) as change

                const change = getter() != value;
                setter(value);
                if (change) {
                    this._contentChangeSubject.next();
                }
            };
            dataTemplate.dataWrapper.setter = dataChangeSetter;
        });

        node.value = templates;
        return node;
    }


    contentChange(): Observable<void> {
        return this._contentChangeSubject.asObservable();
    }


    protected getPrimitiveTemplates(field: XoStructurePrimitive, _: XcTreeNode): XcTemplate[] {
        const templates = XcTemplateFactory.createTemplates(
            field,
            this.container,
            this.readonlyMode,
            // mark for a change, which eventually updates the autocomplete component
            () => this.triggerMarkForChange(),
            this.i18n
        );
        templates.filter(template => template instanceof XcFormTemplate).forEach(template => {
            template.floatLabel = FloatStyle.always;
            // Field name is shown in the tree left column; booleans use a single Yes/No dropdown.
            template.label = '';
        });
        return templates;
    }


    protected getObjectTemplates(field: XoStructureObject, node: XcTreeNode): XcTemplate[] {
        const fieldResolve = (): XoObject => {
            const object = this.container.resolve(field.path);
            return object instanceof XoObject
                ? object
                : null;
        };
        // getter, setter, init
        const getter = (): ComparableDescriber => {
            const fieldDescriber = fieldResolve() || <XoDescriber>{};
            return fieldDescriber.fqn
                ? new ComparableDescriber(fieldDescriber.rtc, fieldDescriber.fqn)
                : null;
        };
        const setter = (value: ComparableDescriber) => {
            const head = this.container.resolveHead(field.path);
            const xo = head.value as Xo;
            const id = head.tail;
            if (value) {
                // initialize object, if not already present
                if (!value.equals(getter())) {
                    let instance: Xo;
                    const rtc = value.rtc || field.typeRtc || this.rtc;
                    const base = xo.decoratorClass ? xo : XoObject.instance;
                    const clazz = base.getDerivedClass(id, value.fqn);
                    if (clazz?.fqn.equals(value.fqn)) {
                        // instantiate derived class
                        instance = new clazz(id);
                        instance.rtc ??= rtc;
                    } else {
                        // instantiate generic xo
                        instance = field.valueInstance(rtc, value.fqn);
                    }
                    xo.assign(id, instance);
                }
                // fetch children
                this.getStructureTreeData(xo.resolve(id), field, node);
            } else {
                // set to undefined or null, depending on whether the object inside an object or an array, respectively
                xo.assign(id, xo instanceof XoObject ? undefined : null);
                // clear children
                field.children = [];
                node.children.next([]);
            }
        };
        const init = (): ComparableDescriber => {
            const value = getter();
            return value && setter(value), value;
        };
        // readonly mode: return text
        if (this.readonlyMode || this.complexTypesReadonly) {
            const value = init();
            const text = value?.fqn
                ? value.fqn.name
                : this.complexTypesReadonly
                    ? field.typeFqn
                    : <any>XcTemplateFactory.PLACEHOLDER_NULL;
            return [text];
        }
        // get subtypes for autocomplete
        const autocompleteDataWrapper = new XcAutocompleteDataWrapper(getter, setter);
        const describer = <XoDescriber>{
            rtc: (fieldResolve() || <XoDescriber>{}).rtc,
            fqn: field.typeFqn
        };
        this.apiService.getSubtypes(this.rtc, [describer], this.subtypesCache).get(describer).subscribe(subtypes => {
            // find types with ambiguous labels
            const subtypeLabels = new Set<string>();
            const ambiguousLabels = new Set<string>();
            subtypes.forEach(type => {
                if (subtypeLabels.has(type.typeLabel)) {
                    ambiguousLabels.add(type.typeLabel);
                } else {
                    subtypeLabels.add(type.typeLabel);
                }
            });

            autocompleteDataWrapper.values = subtypes.map(type => ({
                name: type.typeLabel + (ambiguousLabels.has(type.typeLabel) ? (' ' + type.typeFqn.path) : ''), // show path for ambiguous labels
                value: new ComparableDescriber(type.typeRtc, type.typeFqn),
                disabled: type.typeAbstract
            }));
            // we need to notify the tree component about the autocomplete datawrapper's values change,
            // so it can mark itself for a change as well, which eventually updates the autocomplete component
            this.triggerMarkForChange();
        });
        // create template
        const template = new XcFormAutocompleteTemplate(autocompleteDataWrapper);
        // placeholder and suffix
        template.placeholder = XcTemplateFactory.PLACEHOLDER_NULL;
        template.suffix = 'clear';
        // return template
        init();
        return [template];
    }


    protected getArrayTemplates(field: XoStructureArray, node: XcTreeNode): XcTemplate[] {
        // function to add children to the array
        const addChild = (create: boolean) => {
            // add field
            const childField = field.add();
            if (create) {
                // add newly created value to array
                this.container.resolveAssign(childField.path, null);
            }
            // add node
            const childNode = this.createNodeFromField(childField, node);
            const children = node.children.getValue();
            children.push(childNode);
        };
        // function to inform observers of changes in the children array
        const updateChildren = (trigger: boolean) => {
            node.children.next(node.children.getValue());
            if (trigger) {
                this.triggerMarkForChange();
            }
        };
        // getter, setter, init
        const getter = (): ComparableDescriber => {
            const array = this.container.resolve(field.path);
            return array instanceof XoArray
                ? new ComparableDescriber(array.rtc, array.fqn)
                : array instanceof Array
                    ? new ComparableDescriber(field.typeRtc, field.typeFqn)
                    : null;
        };
        const setter = (value: ComparableDescriber) => {
            const head = this.container.resolveHead(field.path);
            const xo = head.value as Xo;
            const id = head.tail;
            if (value) {
                // initialize array, if not already present
                if (!value.equals(getter())) {
                    const base = xo.decoratorClass ? xo : XoArray.instance;
                    const clazz = base.getDerivedClass(id, value.fqn);
                    const instance = clazz ? new clazz(id) : field.valueInstance(value.rtc || field.typeRtc || this.rtc, value.fqn);
                    xo.assign(id, instance);
                } else {
                    // get array length
                    const array: XoArray = xo.resolve(id);
                    // set node limit
                    node.limit = array.length > this.arrayTypesLimit ? this.arrayTypesLimit : undefined;
                    // function to get the number of remaining child nodes to be added
                    const remainingLength = () => array.length - node.limit;
                    // function to get the number of child nodes to be inserted
                    const insertionLength = () => Math.min(this.arrayTypesLimit, remainingLength());
                    // function to add some more children
                    const addChildren = (count: number) => {
                        for (let i = 0; i < count; i++) {
                            addChild(false);
                        }
                    };
                    // add initial children
                    addChildren(node.limit || array.length);
                    // if node is limited, add the child node that allows inserting more children
                    if (node.limit) {
                        const children = node.children.getValue();
                        // create child node
                        const childNode = this.createNode('', node);
                        // function to update the child node's name and value
                        const updateChildNode = () => {
                            const from = node.limit;
                            const to = node.limit + insertionLength() - 1;
                            childNode.name = '[' + from + ']' + (to > from ? ' - [' + to + ']' : '');
                            childNode.value = ['{+ ' + remainingLength() + '}'];
                        };
                        // set limit to -1 for the child node to be easily distinguished between its ordinary siblings
                        childNode.limit = -1;
                        // set the generic action function to be able to insert more children
                        childNode.action = (update = false) => {
                            if (update) {
                                updateChildNode();
                                return;
                            }
                            // temporarily remove child node
                            children.pop();
                            // add some more children
                            addChildren(insertionLength());
                            // re-add the child node, if still needed
                            if (children.length < array.length) {
                                // increase the node's limit
                                node.limit = Math.min(node.limit + this.arrayTypesLimit, array.length);
                                children.push(childNode);
                                updateChildNode();
                            } else {
                                // reset node's limit
                                node.limit = undefined;
                            }
                            // update children and trigger mark for change
                            updateChildren(true);
                        };
                        // add child node
                        children.push(childNode);
                        updateChildNode();
                    }
                    // finally, update children
                    updateChildren(false);
                }
            } else {
                // set to undefined or null, depending on whether the array is inside an object or an array, respectively
                // (note: do it even though an array can't contain an array. this is a server-side limitation in the declaration of xyna objects)
                xo.assign(id, xo instanceof XoObject ? undefined : null);
                // clear children
                field.children = [];
                node.children.next([]);
            }
        };
        const init = (): ComparableDescriber => {
            // if the complex type won't be editable, instantiate it initially
            const value = getter() || (this.complexTypesReadonly ? new ComparableDescriber(field.typeRtc, field.typeFqn) : null);
            return value && setter(value), value;
        };
        // create add button template
        const iconButtonTemplate = new XcIconButtonTemplate();
        iconButtonTemplate.iconName = XcStructureTreeDataSource.ICON_NAME_ADD;
        iconButtonTemplate.action = () => {
            // restore all ordinary children before adding a new one
            while (node.limit !== undefined) {
                const children = node.children.getValue();
                const childNode = children[children.length - 1];
                childNode.action();
            }
            // add new child
            addChild(true);
            updateChildren(false);
        };
        // A11y
        iconButtonTemplate.label = this.i18n?.translate('zeta.xc.tree.add-element') ?? 'Add Element';
        // disabled accessor
        defineAccessorProperty<XcIconButtonTemplate, boolean>(
            iconButtonTemplate,
            'disabled',
            () => node.readonly || !getter()
        );
        // readonly mode: return text
        if (this.readonlyMode || this.complexTypesReadonly) {
            const value = init();
            const text = value != null && value.fqn
                ? ('[' + value.fqn.name + ']')
                : <any>XcTemplateFactory.PLACEHOLDER_NULL;
            return this.complexTypesReadonly ? [text, iconButtonTemplate] : [text];
        }
        // create template
        const template = new XcFormAutocompleteTemplate(new XcAutocompleteDataWrapper(
            getter, setter, [{
                name: '[' + field.typeLabel + ']',
                value: new ComparableDescriber(field.typeRtc, field.typeFqn),
                disabled: field.typeAbstract
            }]
        ));
        // placeholder and suffix
        template.placeholder = XcTemplateFactory.PLACEHOLDER_NULL;
        template.suffix = 'clear';
        // return template
        init();
        return [template, iconButtonTemplate];
    }


    protected getTemplates(field: XoStructureField, node: XcTreeNode): XcTemplate[] {
        // set node's readonly flag
        const resolved = this.container.resolveHead(field.path);
        node.readonly = resolved.value instanceof XoObject && resolved.value.readonlyProperties.has(resolved.tail);
        // set tooltip
        node.tooltip = field.docu;
        // get templates array
        let templates: XcTemplate[] = [];
        if (field instanceof XoStructurePrimitive) {
            templates = this.getPrimitiveTemplates(field, node);
        } else if (field instanceof XoStructureObject) {
            templates = this.getObjectTemplates(field, node);
        } else if (field instanceof XoStructureArray) {
            templates = this.getArrayTemplates(field, node);
        }
        if (this.readonlyMode) {
            return templates;
        }
        // create delete button template for children of arrays
        const parentField = field.parent;
        if (parentField instanceof XoStructureArray) {
            const iconButtonTemplate = new XcIconButtonTemplate();
            iconButtonTemplate.iconName = XcStructureTreeDataSource.ICON_NAME_DELETE;
            iconButtonTemplate.action = () => {
                // remove value from array
                this.container.resolveDelete(field.path);
                // remove field
                const idx = parentField.remove(field);
                // remove node
                const parentNode = node.parent;
                const children = parentNode.children.getValue();
                if (idx >= 0) {
                    // reduce limit, if any
                    if (parentNode.limit > 0) {
                        parentNode.limit--;
                    }
                    // update name of all following nodes
                    let limitNode: XcTreeNode;
                    let i = children.length;
                    while (--i > idx) {
                        const child = children[i];
                        if (child.limit !== -1) {
                            child.name = children[i - 1].name;
                        } else {
                            limitNode = child;
                        }
                    }
                    // remove node
                    children.splice(idx, 1);
                    parentNode.children.next(children);
                    node.parent = null;
                    // update name and value of limit node
                    limitNode?.action(true);
                }
            };
            // A11y
            iconButtonTemplate.label = this.i18n?.translate('zeta.xc.tree.remove-element') ?? 'Remove Element';
            // disabled accessor
            defineAccessorProperty<XcIconButtonTemplate, boolean>(
                iconButtonTemplate,
                'disabled',
                () => node.parent.readonly
            );
            templates.push(iconButtonTemplate);
        }
        templates.forEach(template => {
            // compact style for all form templates
            if (template instanceof XcFormTemplate) {
                template.compact = true;
            }
            // readonly
            if (!template.disabled && (template instanceof XcFormTemplate || template instanceof XcCheckboxTemplate)) {
                // disabled accessor
                defineAccessorProperty<typeof template, boolean>(
                    template,
                    'disabled',
                    () => node.readonly
                );
            }
        });
        return templates;
    }
}
