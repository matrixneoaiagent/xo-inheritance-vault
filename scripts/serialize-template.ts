import { generateTemplateIdentifier, parseTemplate, serializeTemplate } from '@xo-cash/utils';
import { writeFileSync } from 'node:fs';
import { inheritanceVaultTemplate } from '../source/index.js';

const parsed = parseTemplate(inheritanceVaultTemplate);
const identifier = generateTemplateIdentifier(parsed);
writeFileSync(new URL('../fixtures/inheritance-vault.template.json', import.meta.url), `${serializeTemplate(parsed)}\n`);
console.log('TEMPLATE_IDENTIFIER', identifier);
console.log('ACTIONS', Object.keys(parsed.actions).join(','));
console.log('WROTE', 'fixtures/inheritance-vault.template.json');
