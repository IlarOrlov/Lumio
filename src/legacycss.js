'use strict';
/**
 * Builds a stylesheet for browsers without CSS custom properties (older smart
 * TVs): every var(--x) is replaced by its value, taken from the same rule if it
 * defines --x, otherwise from :root, otherwise the var() fallback or a neutral
 * default. Done once at startup; the result is served as /style.legacy.css.
 */
const DEFAULTS = { '--rx': '0deg', '--ry': '0deg', '--gx': '50%', '--gy': '50%', '--pct': '0%' };
const DECL = /(--[\w-]+)\s*:\s*([^;{}]+);?/g;
const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g;

function legacyCss(css) {
  const root = {};
  const rootBlock = /:root\s*\{([^{}]*)\}/.exec(css);
  if (rootBlock) for (const m of rootBlock[1].matchAll(DECL)) root[m[1]] = m[2].trim();
  const resolve = (value, local, depth = 0) => value.replace(VAR, (all, name, fb) => {
    if (depth > 6) return fb ? fb.trim() : '';
    const v = local[name] ?? root[name] ?? (fb !== undefined ? fb.trim() : DEFAULTS[name]);
    return v === undefined ? 'initial' : resolve(v, local, depth + 1);
  });
  // innermost blocks hold the declarations; @media/@supports wrappers are kept as they are
  return css.replace(/([^{}]*)\{([^{}]*)\}/g, (all, sel, body) => {
    const local = {};
    for (const m of body.matchAll(DECL)) local[m[1]] = m[2].trim();
    const cleaned = body.replace(DECL, '').replace(/^\s*;/, '');
    return `${sel}{${resolve(cleaned, local)}}`;
  });
}

module.exports = { legacyCss };
