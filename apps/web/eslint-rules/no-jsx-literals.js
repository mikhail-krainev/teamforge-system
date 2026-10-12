// Custom rule: user-visible text must come from the i18n dictionaries, never from JSX literals.
const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'title',
  'alt',
  'placeholder',
  'label',
]);
// Text without a single letter or digit (separators like "/" or "·") is not translatable copy.
const HAS_WORD_CHARS = /[\p{L}\p{N}]/u;

function isCopy(value) {
  return typeof value === 'string' && HAS_WORD_CHARS.test(value);
}

function staticString(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('');
  }
  return undefined;
}

export const noJsxLiterals = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      text: 'Hard-coded text in JSX. Move it to src/i18n/ru/*.json and use t(key).',
      expression: 'Hard-coded string in a JSX expression. Use t(key) with a dictionary entry.',
      attribute: 'Hard-coded text in the "{{name}}" attribute. Use t(key) with a dictionary entry.',
    },
  },
  create(context) {
    return {
      JSXText(node) {
        if (isCopy(node.value)) context.report({ node, messageId: 'text' });
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === 'JSXAttribute') return;
        if (isCopy(staticString(node.expression))) context.report({ node, messageId: 'expression' });
      },
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : undefined;
        if (!name || !TEXT_ATTRIBUTES.has(name) || !node.value) return;
        const value =
          node.value.type === 'JSXExpressionContainer'
            ? staticString(node.value.expression)
            : staticString(node.value);
        if (isCopy(value)) context.report({ node, messageId: 'attribute', data: { name } });
      },
    };
  },
};

export default { rules: { 'no-jsx-literals': noJsxLiterals } };
