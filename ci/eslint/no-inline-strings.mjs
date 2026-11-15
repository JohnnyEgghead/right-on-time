// SPDX-License-Identifier: AGPL-3.0-or-later
// no-inline-strings (SPECIFICATIONS section 6.11; FR-LANG-2): a user-visible string in JSX comes
// from the i18n catalog, never from a literal. Flags JSX text, string literals in JSX
// expression containers, and string literals on the attributes people read or hear.
// React Native reads accessibilityLabel and accessibilityHint aloud; message, text and hint are the text props custom components take (F-135).
// The literal branches of a conditional or logical expression, and an identifier bound to a literal, count as the literal.
// A string with no letter in it ("/", "|", digits, bullets) is punctuation, not copy.
const VISIBLE_ATTRIBUTES = new Set(['alt', 'title', 'placeholder', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'accessibilityLabel', 'accessibilityHint', 'message', 'text', 'hint']);
const hasLetter = (text) => /\p{L}/u.test(text);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'User-facing strings come from the i18n catalog' },
    messages: {
      inline: 'Inline user-visible string "{{text}}": add a catalog key and render it through @bw/i18n.',
    },
    schema: [],
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: 'inline', data: { text: text.trim().slice(0, 40) } });
    // Every literal string a JSX value can show: the literal itself, both branches of a conditional or logical
    // expression, and the literal a const identifier is bound to.
    const staticTexts = (expr, node) => {
      if (!expr) return [];
      if (expr.type === 'Literal' && typeof expr.value === 'string') return [expr.value];
      if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return [expr.quasis[0].value.cooked ?? ''];
      if (expr.type === 'ConditionalExpression') return [...staticTexts(expr.consequent, node), ...staticTexts(expr.alternate, node)];
      if (expr.type === 'LogicalExpression') return [...staticTexts(expr.left, node), ...staticTexts(expr.right, node)];
      if (expr.type === 'TSAsExpression' || expr.type === 'TSNonNullExpression') return staticTexts(expr.expression, node);
      if (expr.type === 'Identifier') {
        for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
          const variable = scope.set.get(expr.name);
          if (!variable) continue;
          const def = variable.defs.length === 1 ? variable.defs[0] : null;
          if (def?.type === 'Variable' && def.parent?.kind === 'const' && def.node.init) return staticTexts(def.node.init, node);
          return [];
        }
      }
      return [];
    };
    const reportAll = (node, expr) => {
      for (const text of staticTexts(expr, node)) if (hasLetter(text)) report(node, text);
    };
    return {
      JSXText(node) {
        if (hasLetter(node.value)) report(node, node.value);
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === 'JSXAttribute') return; // attributes: handled below
        reportAll(node, node.expression);
      },
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
        if (!name || !VISIBLE_ATTRIBUTES.has(name) || !node.value) return;
        reportAll(node, node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value);
      },
    };
  },
};
