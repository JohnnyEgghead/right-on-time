// SPDX-License-Identifier: AGPL-3.0-or-later
// log-allowlist (P2-CLOSE, F-234; SPECIFICATIONS section 11.4 and section 14 Static; invariant 6's code half; NFR-05).
// A process writes its log lines only through @bw/log, whose typed allowlist admits no free text. This rule flags every
// other way a process package can put text on its output, so a phone number or address cannot reach a container log:
//   console.<any method> (called, passed as a value, or destructured: `const { log } = console`);
//   process.stdout.write and process.stderr.write (the free-text write), and process.stdout / process.stderr taken
//   as a value (an alias, a pipe target);
//   fs.writeSync / writeSync with a literal fd 1 or 2 (process.stdout.fd is caught as a use of process.stdout).
// Each also through globalThis., global., window. or self., and in computed form (console['log']).
// A local binding named console or process (a parameter, an import) is not the global and is not flagged.
// A @bw/log call (log.info({ ... }), logger.error({ ... })) is none of these and is not flagged.
// eslint.config.mjs scopes it to the 3 process apps' sources (apps/web, apps/worker, apps/pbs); @bw/log itself, which
// owns the one stdout write, is outside that scope.

const GLOBAL_HOSTS = new Set(['globalThis', 'window', 'self', 'global']);
const STREAMS = new Set(['stdout', 'stderr']);
const MESSAGE = 'A process writes log lines only through @bw/log (typed field allowlist, SPECIFICATIONS 11.4); console and stdout/stderr writes carry free text.';

function propName(member) {
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  if (member.computed && member.property.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function isLocal(name, node, context) {
  let s = context.sourceCode.getScope(node);
  while (s) {
    const v = s.set.get(name);
    if (v) return v.defs.length > 0;
    s = s.upper;
  }
  return false;
}

/** True when `node` stands for the global `name`: the bare identifier (not a local binding) or a global host's member. */
function isGlobal(node, name, context) {
  if (node.type === 'Identifier') return node.name === name && !isLocal(name, node, context);
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && GLOBAL_HOSTS.has(node.object.name)) {
    return propName(node) === name;
  }
  return false;
}

/** `process.stdout` or `process.stderr` (any spelling of the host and of the member). */
function isStream(node, context) {
  return node.type === 'MemberExpression' && isGlobal(node.object, 'process', context) && STREAMS.has(propName(node) ?? '');
}

export default {
  meta: { type: 'problem', docs: { description: 'Log calls carry only allowlisted fields: no console, no free-text stdout or stderr write' }, schema: [] },
  create(context) {
    const report = (node) => context.report({ node, message: MESSAGE });
    return {
      MemberExpression(node) {
        if (isGlobal(node.object, 'console', context)) return report(node);
        if (isStream(node, context)) return report(node);
      },
      // const { log } = console; const { stdout } = process;
      VariableDeclarator(node) {
        if (node.id.type === 'ObjectPattern' && node.init) {
          if (isGlobal(node.init, 'console', context)) return report(node);
          if (isGlobal(node.init, 'process', context) && node.id.properties.some((p) => p.type === 'Property' && STREAMS.has(p.key.name ?? p.key.value))) return report(node);
        }
      },
      // writeSync(1, ...), fs.writeSync(2, ...)
      CallExpression(node) {
        const c = node.callee;
        const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? propName(c) : null;
        if (name !== 'writeSync') return;
        const fd = node.arguments[0];
        if (!fd) return;
        if (fd.type === 'Literal' && (fd.value === 1 || fd.value === 2)) return report(node);
      },
    };
  },
};
