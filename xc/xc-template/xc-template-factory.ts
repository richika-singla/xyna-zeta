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
import { Xo, XoStructureField } from '../../api';
import { defineAccessorProperty } from '../../base';
import { I18nService } from '../../i18n';
import { XcIdentityDataWrapper, XcStringFloatDataWrapper, XcStringIntegerDataWrapper } from '../shared/xc-data-wrapper';
import { XcAutocompleteDataWrapper } from '../xc-form/xc-form-autocomplete/xc-form-autocomplete.component';
import { XcFormValidatorNumber } from '../xc-form/xc-form-base/xc-form-validators.directive';
import { XcFormAutocompleteTemplate, XcFormInputTemplate, XcFormTemplate, XcTemplate } from './xc-template';


export class XcTemplateFactory {

    static readonly PLACEHOLDER_ZERO  = '0';
    static readonly PLACEHOLDER_NULL  = '{null}';
    static readonly PLACEHOLDER_FALSE = 'false';


    static getBooleanOptions(nullable: boolean, i18n?: I18nService): { name: string; value: boolean }[] {
        const yes = i18n ? i18n.translate('zeta.xc.tree.boolean.yes') : 'Yes';
        const no = i18n ? i18n.translate('zeta.xc.tree.boolean.no') : 'No';
        const options = [{ name: no, value: false }, { name: yes, value: true }];
        if (nullable) {
            const unset = i18n ? i18n.translate('zeta.xc.tree.boolean.unset') : 'Not set';
            return [{ name: unset, value: null as unknown as boolean }, ...options];
        }
        return options;
    }


    static formatBooleanForReadonly(value: unknown, nullable: boolean, i18n?: I18nService): string {
        if (value == null) {
            return nullable
                ? (i18n ? i18n.translate('zeta.xc.tree.boolean.unset') : 'Not set')
                : XcTemplateFactory.PLACEHOLDER_NULL;
        }
        if (value === true) {
            return i18n ? i18n.translate('zeta.xc.tree.boolean.yes') : 'Yes';
        }
        if (value === false) {
            return i18n ? i18n.translate('zeta.xc.tree.boolean.no') : 'No';
        }
        return String(value);
    }


    static createTemplates(field: XoStructureField, instance: Xo, readonly = false, autocompleteValuesChange?: () => void, i18n?: I18nService): XcTemplate[] {
        const create = (getter: () => any, setter: (value: any) => void, nullable: boolean): XcTemplate[] => {
            const templates: XcTemplate[] = [];

            // enumerated data wrapper
            const enumeratedDataWrapper = XcAutocompleteDataWrapper.fromXoEnumeratedPropertyPath(instance, field.path, nullable, {options: () => {
                // notify the caller about the autocomplete datawrapper's options change
                if (autocompleteValuesChange) {
                    autocompleteValuesChange();
                }
            }});

            // is field enumerated?
            if (enumeratedDataWrapper) {
                templates.push(new XcFormAutocompleteTemplate(enumeratedDataWrapper));
            } else if (field.typeFqn.boolLike) {
                // --< BOOLEAN >--
                const autocompleteTemplate = new XcFormAutocompleteTemplate(new XcAutocompleteDataWrapper(
                    getter,
                    setter,
                    XcTemplateFactory.getBooleanOptions(nullable, i18n),
                    nullable
                ));
                autocompleteTemplate.asDropdown = true;
                templates.push(autocompleteTemplate);
            } else if (field.typeFqn.stringLike) {
                // --< STRING >--
                templates.push(new XcFormInputTemplate(new XcIdentityDataWrapper(getter, setter)));
            } else if (field.typeFqn.intLike) {
                // --< INTEGER, LONG >--
                templates.push(new XcFormInputTemplate(new XcStringIntegerDataWrapper(getter, setter, nullable), [XcFormValidatorNumber('decimal')]));
            } else if (field.typeFqn.floatLike) {
                // --< FLOAT, DOUBLE >--
                templates.push(new XcFormInputTemplate(new XcStringFloatDataWrapper(getter, setter, nullable), [XcFormValidatorNumber('float')]));
            }
            return templates;
        };

        return this.createTemplatesWithParameters(field, instance, create, readonly, i18n);
    }



    static createTemplatesWithParameters(field: XoStructureField, instance: Xo,
        createFn: (getter: () => any, setter: (value: any) => void, nullable: boolean) => XcTemplate[],
        readonly = false,
        i18n?: I18nService
    ): XcTemplate[] {
        // set nullable and placeholder
        const nullable = field.typeFqn.isNullablePrimitive();
        const placeholder = nullable
            ? XcTemplateFactory.PLACEHOLDER_NULL
            : field.typeFqn.isNumericPrimitive()
                ? XcTemplateFactory.PLACEHOLDER_ZERO
                : XcTemplateFactory.PLACEHOLDER_FALSE;

        // define setter, getter and init
        const setter = (value: any) => instance.resolveAssign(field.path, value);
        const getter = (): any      => instance.resolve(field.path);
        const init   = (): any      => {
            const value = getter();
            return nullable && value == null && setter(null), value;
        };

        // readonly mode: return text
        if (readonly) {
            const value = init();
            const text = field.typeFqn.boolLike
                ? XcTemplateFactory.formatBooleanForReadonly(value, nullable, i18n)
                : value != null
                    ? (field.typeFqn.stringLike ? '"' + value + '"' : value)
                    : placeholder;
            return [text];
        }

        // create templates
        const templates: XcTemplate[] = createFn ? createFn(getter, setter, nullable) : [];

        // extend form templates
        templates.forEach(template => {
            if (template instanceof XcFormTemplate) {
                // specify placeholder accessor (if placeholder has not been set before)
                if (!template.placeholder) {
                    defineAccessorProperty<typeof template, string>(
                        template,
                        'placeholder',
                        () => getter() == null ? placeholder : ''
                    );
                }
                // suffix for nullable primitives
                if (nullable) {
                    template.suffix = 'nullify';
                }
                // set label
                template.label = field.label;
            }
        });

        init();
        return templates;
    }
}
