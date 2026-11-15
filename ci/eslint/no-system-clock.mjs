// SPDX-License-Identifier: AGPL-3.0-or-later
// no-system-clock (P2-TIME; SPECIFICATIONS section 4.2, section 11.3; FR-DEMO-2): code reads time through @bw/time,
// never the system clock. eslint.config.mjs scopes it to apps/ and packages/ and leaves out only the seam's 1 reader,
// packages/time/src/real.ts. Flagged reads of now:
//   Date.now (called or passed as a value), new Date() with no argument, Date() called as a function,
//   performance.timeOrigin, and Temporal.Now (any of its readers); (F-177) Intl.DateTimeFormat(...).format() and
//   .formatToParts() called with no argument; new Date(...[]); and the Date global used as a bare value (an alias,
//   destructuring, Reflect.construct(Date, [])): only Date.<member>, new Date(x), Date(), instanceof Date, typeof Date
//   and type positions use the name without taking the global as a value.
// Each also caught through globalThis., window., self. or global. and in computed form (Date['now']).
// A local binding named Date or performance (a parameter, an import) is not the global and is not flagged;
// Temporal.Now is flagged whatever Temporal is bound to, since the polyfill's Temporal reads the clock too.

const GLOBAL_HOSTS = new Set(['globalThis', 'window', 'self', 'global']);

function propName(member) {
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  if (member.computed && member.property.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The global name an expression stands for: `Date`, `globalThis.Date`, `window['Date']`; null when it is not a global. */
function globalName(node, context) {
  if (node.type === 'Identifier') {
    const scope = context.sourceCode.getScope(node);
    let s = scope;
    while (s) {
      const v = s.set.get(node.name);
      if (v) return v.defs.length > 0 ? null : node.name;
      s = s.upper;
    }
    return node.name;
  }
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && GLOBAL_HOSTS.has(node.object.name)) {
    return propName(node);
  }
  return null;
}

/** `Temporal`, bound to anything: the global, the polyfill import, or a re-export. */
function isTemporal(node) {
  if (node.type === 'Identifier') return node.name === 'Temporal';
  return node.type === 'MemberExpression' && propName(node) === 'Temporal';
}

/** The Date global (bare or through a global host) used as a plain value rather than as an owner of a member or a callee. */
function isDateValueUse(node, context) {
  if (globalName(node, context) !== 'Date') return false;
  const p = node.parent;
  if (!p || p.type.startsWith('TS')) return false;
  if (p.type === 'MemberExpression' && (p.object === node || p.property === node)) return false;
  if ((p.type === 'NewExpression' || p.type === 'CallExpression') && p.callee === node) return false;
  if (p.type === 'BinaryExpression' && p.operator === 'instanceof' && p.right === node) return false;
  if (p.type === 'UnaryExpression' && p.operator === 'typeof') return false;
  if (p.type === 'Property' && p.key === node && !p.computed && !p.shorthand) return false;
  if ((p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') && p.key === node && !p.computed) return false;
  if (p.type === 'ExportSpecifier' || p.type === 'ImportSpecifier') return false;
  return true;
}

function isIntlDateTimeFormat(node, context) {
  return (node.type === 'NewExpression' || node.type === 'CallExpression')
    && node.callee.type === 'MemberExpression'
    && propName(node.callee) === 'DateTimeFormat'
    && globalName(node.callee.object, context) === 'Intl';
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Code reads time through @bw/time, never the system clock' },
    schema: [],
    messages: {
      read: '{{what}} reads the system clock: take demo time from the clock seam (Clock.demoNow) or real time from realNow(use) of @bw/time (SPECIFICATIONS section 4.2, section 11.3).',
    },
  },
  create(context) {
    const report = (node, what) => context.report({ node, messageId: 'read', data: { what } });
    return {
      MemberExpression(node) {
        if (isDateValueUse(node, context)) report(node, 'The Date global used as a value');
        const name = propName(node);
        if (name === 'now' && globalName(node.object, context) === 'Date') report(node, 'Date.now');
        else if (name === 'timeOrigin' && globalName(node.object, context) === 'performance') report(node, 'performance.timeOrigin');
        else if (name === 'Now' && isTemporal(node.object)) report(node, 'Temporal.Now');
      },
      NewExpression(node) {
        if (globalName(node.callee, context) !== 'Date') return;
        const [only] = node.arguments;
        const emptySpread = node.arguments.length === 1 && only.type === 'SpreadElement' && only.argument.type === 'ArrayExpression' && only.argument.elements.length === 0;
        if (node.arguments.length === 0 || emptySpread) report(node, 'new Date()');
      },
      CallExpression(node) {
        if (globalName(node.callee, context) === 'Date') report(node, 'Date()');
        else if (node.arguments.length === 0 && node.callee.type === 'MemberExpression' && ['format', 'formatToParts'].includes(propName(node.callee)) && isIntlDateTimeFormat(node.callee.object, context)) {
          report(node, `Intl.DateTimeFormat ${propName(node.callee)}() with no argument`);
        }
      },
      Identifier(node) {
        if (isDateValueUse(node, context)) report(node, 'The Date global used as a value');
      },
    };
  },
};
