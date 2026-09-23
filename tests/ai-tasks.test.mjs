#!/usr/bin/env node
/**
 * Editorial AI: the writing assistant (C-163) and draft translation (C-134).
 *
 * The roadmap said of C-163 that "the provider plumbing is real and reusable"
 * and of C-134 that the assistant "exists". Both were true and neither meant a
 * writer could do anything: there was no button anywhere in the admin. These
 * tests are about the two things that make the feature safe rather than the
 * two things that make it work — that it never writes on its own, and that a
 * provider's answer is never trusted as markup.
 *
 * Run with:  node tests/ai-tasks.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const T = await loadTs('src/lib/ai-tasks.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const route = await read('src/pages/api/assistant/assist.ts');
const chatRoute = await read('src/pages/api/assistant/chat.ts');
const panel = await read('src/components/admin/AiAssist.astro');
const newEditor = await read('src/pages/admin/posts/new.astro');
const editEditor = await read('src/pages/admin/posts/[id]/edit.astro');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
/** Source text with comments removed — a check must not pass or fail on prose. */
function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(?:\/\/|\s\*).*$/gm, '');
}

// ─────────────────────────────────────────────────────── the catalogue

check('every task is complete — no half-declared entry', () => {
  ok(T.AI_TASKS.length >= 6, `only ${T.AI_TASKS.length} tasks`);
  for (const t of T.AI_TASKS) {
    ok(t.id && t.label && t.hint, `${t.id}: missing label or hint`);
    ok(t.output === 'html' || t.output === 'text', `${t.id}: output is ${t.output}`);
    ok(Number.isFinite(t.maxInput) && t.maxInput > 0, `${t.id}: maxInput`);
  }
});

check('an unknown task id is not a task', () => {
  ok(T.getAiTask('improve'), 'improve is missing');
  for (const junk of ['', 'nope', '__proto__', 'constructor', 'toString']) {
    ok(!T.getAiTask(junk), `${junk} resolved to a task`);
  }
});

check('EVERY task tells the model to answer with the text only', () => {
  // A model that says "Sure! Here's a tighter version:" produces an excerpt
  // beginning with "Sure!" the moment an editor presses apply.
  for (const t of T.AI_TASKS) {
    const p = T.taskPrompt(t, 'de');
    ok(/nothing else/i.test(p), `${t.id} does not forbid a preamble`);
  }
});

check('EVERY task except translate keeps the input language', () => {
  // Both live installs write Greek. A helper that answers in English because
  // the instruction was in English is the feature not working.
  for (const t of T.AI_TASKS) {
    if (t.id === 'translate') continue;
    ok(/same language/i.test(T.taskPrompt(t)), `${t.id} may answer in another language`);
  }
});

check('the operator\'s VISITOR persona is not inherited', () => {
  // cfg.systemPrompt is written for a shop's customers ("be friendly, mention
  // our opening hours"). Inheriting it gives an excerpt in a sales voice.
  ok(/systemPrompt: prompt/.test(code(route)), 'the route does not override the system prompt');
  ok(!/cfg\.systemPrompt/.test(code(route)), 'the route reads the visitor persona');
});

// ──────────────────────────────────────────────────────── translation

check('translate names the language, in a form a model understands', () => {
  ok(/German/.test(T.taskPrompt(T.getAiTask('translate'), 'de')), T.taskPrompt(T.getAiTask('translate'), 'de'));
  ok(/Greek/.test(T.taskPrompt(T.getAiTask('translate'), 'el')));
  ok(/Arabic/.test(T.taskPrompt(T.getAiTask('translate'), 'ar')));
});

check('a region does not become a different language', () => {
  ok(/German/.test(T.taskPrompt(T.getAiTask('translate'), 'de-AT')), 'de-AT');
});

check('NO LANGUAGE, NO PROMPT — the second door', () => {
  // "Translate into ." is an instruction a model will answer by guessing.
  for (const junk of ['', null, undefined, '   ']) {
    ok(T.taskPrompt(T.getAiTask('translate'), junk) === '', `prompt built for ${JSON.stringify(junk)}`);
  }
  ok(/if \(!prompt\)/.test(code(route)), 'the route would send an empty prompt');
});

check('translate is told to translate and NOTHING else', () => {
  const p = T.taskPrompt(T.getAiTask('translate'), 'de');
  ok(/do not summarise/i.test(p) && /do not improve/i.test(p), p.slice(0, 120));
  ok(/keep exactly the same tags/i.test(p), 'the markup is not protected');
});

// ──────────────────────────────────────────────────────────── bounds

check('an empty field costs nothing', () => {
  const t = T.getAiTask('improve');
  ok(T.taskInputProblem(t, ''), 'an empty input was accepted');
  ok(T.taskInputProblem(t, '   \n  '), 'whitespace was accepted');
  ok(T.taskInputProblem(t, 'real text') === null, 'real text was refused');
});

check('an oversized input is refused BEFORE it costs the operator money', () => {
  const t = T.getAiTask('improve');
  ok(T.taskInputProblem(t, 'x'.repeat(t.maxInput + 1)), 'over the cap was accepted');
  ok(T.taskInputProblem(t, 'x'.repeat(t.maxInput)) === null, 'exactly the cap was refused');
});

check('translate refuses without a target language', () => {
  const t = T.getAiTask('translate');
  ok(T.taskInputProblem(t, 'text'), 'no locale was accepted');
  ok(T.taskInputProblem(t, 'text', 'de') === null, 'de was refused');
});

check('the reply budget is bigger than the chat bubble\'s', () => {
  // A truncated rewrite is worse than none: the editor pastes it in and loses
  // the last third of their article.
  ok(T.AI_TASK_REPLY_TOKENS >= 4000, `${T.AI_TASK_REPLY_TOKENS}`);
});

// ───────────────────────────────────── the answer is not trusted markup

check('an HTML task is SANITIZED, not passed through', () => {
  const t = T.getAiTask('improve');
  const out = T.cleanTaskReply(t, '<p>fine</p><script>alert(1)</script><img src=x onerror="alert(1)">');
  ok(!/script/i.test(out), out);
  ok(!/onerror/i.test(out), out);
  ok(/fine/.test(out), 'the real content was destroyed too');
});

check('AN ENTITY-ENCODED TAG DOES NOT COME BACK TO LIFE', () => {
  // The subtle one. `plainText` DECODES entities — which is why it is the right
  // function for `&amp;` in a customer's name — so a provider answering
  // `&lt;img src=x onerror=…&gt;` survived sanitizeHtml as escaped TEXT and was
  // then decoded back into live markup, which the editor writes into innerHTML.
  // The sanitizer therefore runs again on the decoded result.
  for (const id of ['excerpt', 'title', 'meta_description']) {
    const out = T.cleanTaskReply(T.getAiTask(id), '&lt;img src=x onerror="alert(1)"&gt;fine');
    ok(!/<img/i.test(out), `${id}: a tag came back to life — ${out}`);
    ok(!/onerror/i.test(out), `${id}: ${out}`);
  }
  // Doubly and triply encoded: two passes are not enough, so it runs to a
  // fixed point. Each of these needs one more round than the last.
  for (const payload of [
    '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;',
    '&amp;amp;lt;script&amp;amp;gt;alert(1)&amp;amp;lt;/script&amp;amp;gt;',
  ]) {
    const out = T.cleanTaskReply(T.getAiTask('excerpt'), payload);
    ok(!/<script/i.test(out), `${payload} → ${out}`);
    ok(!/</.test(out), `an angle bracket survived: ${out}`);
  }
});

check('...while a real ampersand still decodes, which is why plainText is used', () => {
  const out = T.cleanTaskReply(T.getAiTask('title'), 'Frames &amp; Lenses');
  ok(out === 'Frames & Lenses', out);
});

check('a TEXT field never receives a tag', () => {
  // A <p> in the excerpt shows up escaped on the listing card.
  for (const id of ['excerpt', 'title', 'meta_description']) {
    const out = T.cleanTaskReply(T.getAiTask(id), '<p>A short summary.</p>');
    ok(!out.includes('<'), `${id}: ${out}`);
    ok(out.includes('A short summary.'), `${id}: content lost — ${out}`);
  }
});

check('a code fence and wrapping quotes are stripped', () => {
  const t = T.getAiTask('title');
  ok(T.cleanTaskReply(t, '```\nA Title\n```') === 'A Title');
  ok(T.cleanTaskReply(t, '"A Title"') === 'A Title');
  // ...but a quotation INSIDE the text is content, not a wrapper.
  ok(T.cleanTaskReply(t, 'He said "no" and left') === 'He said "no" and left');
});

// ──────────────────────────────────────────────── the endpoint's shape

check('AUTHENTICATED and capability-gated — EVERY handler, not just one', () => {
  // Every call spends the operator's own credit. The public bubble is bounded;
  // this one is bounded AND closed.
  //
  // Checked per handler: the first version of this test matched anywhere in the
  // file, so deleting the gate from POST still passed on GET's. A route with two
  // exported handlers needs the rule asserted twice, because that is exactly
  // where one of them gets missed.
  const src = code(route);
  const handlers = ['POST', 'GET'].map((verb) => {
    const from = src.indexOf(`export const ${verb}: APIRoute`);
    ok(from >= 0, `no ${verb} handler`);
    const rest = src.slice(from + 10);
    const next = rest.indexOf('export const ');
    return [verb, next < 0 ? rest : rest.slice(0, next)];
  });
  for (const [verb, body] of handlers) {
    ok(/if \(!user\) return ApiResponseBuilder\.unauthorized\(\)/.test(body), `${verb}: anonymous callers are not refused`);
    ok(/canAuthorPosts\(user\.role\)/.test(body), `${verb}: not capability-gated`);
  }
  ok(!/canAuthorPosts/.test(code(chatRoute)), 'the public route grew an admin gate');
});

check('the plugin switch is obeyed here too', () => {
  // The chat route once resolved the config itself and never asked whether the
  // plugin was active — a billing surface on a switched-off feature.
  ok(/liveAssistantConfig\(\)/.test(code(route)), 'does not ask whether the assistant is live');
  ok(!/resolveAssistantConfig/.test(code(route)), 'resolves the config a second time');
  ok(/ensurePluginsBootstrapped/.test(code(route)), 'a cold request would 404 a live assistant');
});

check('a target locale must be one this install RUNS', () => {
  ok(/locales\(\)\.includes\(target\)/.test(code(route)), 'any language string is accepted');
});

check('THE ENDPOINT NEVER WRITES', () => {
  // This is what makes "draft translation" safe to offer at all.
  for (const writer of ['createPost', 'updatePost', 'LocalDB.savePost', 'updateSetting', 'LocalDB.create']) {
    ok(!code(route).includes(writer), `it calls ${writer}`);
  }
});

check('provider detail stays in the log', () => {
  // A provider's error body names accounts, quotas and sometimes the
  // credential. The first version of the leak check required `reply.failure`
  // to appear BEFORE `ApiResponseBuilder` on the line — but a real leak reads
  // `ApiResponseBuilder.serverError(reply.failure)`, the other way round, so
  // the pattern could never match. An audit added exactly that leak and this
  // file stayed green.
  ok(/console\.error\('AI task failed:'/.test(route), 'the failure record is not logged');
  ok(!/ApiResponseBuilder\.[a-zA-Z]+\([^)]*reply\.failure/.test(code(route)),
    'the failure record is handed to the browser');
});

check('THE INPUT BOUNDS ARE ENFORCED BY THE ROUTE, not merely defined', () => {
  // `taskInputProblem` is tested thoroughly as a pure function — and the route
  // could ignore it entirely. An audit replaced the call with `const problem =
  // null` and this file passed, leaving an unbounded body forwarded to a
  // provider the operator pays per token.
  const src = code(route);
  ok(/const problem = taskInputProblem\(task, text, target\)/.test(src), 'the route does not check its bounds');
  ok(/if \(problem\) return ApiResponseBuilder\.badRequest\(problem\)/.test(src), 'the verdict is computed and dropped');
});

// ────────────────────────────────────────────────────────── the panel

check('BOTH post editors carry the panel', () => {
  // Two editors with different ids on the same fields is exactly the shape
  // where one gets the feature and the other is found broken months later.
  ok(/<AiAssist \/>/.test(newEditor), 'posts/new has no panel');
  ok(/<AiAssist \/>/.test(editEditor), 'posts/[id]/edit has no panel');
});

check('the panel finds the editor by CLASS, not by id', () => {
  // `posts/new` gives it id="post-content"; `posts/[id]/edit` takes the default
  // id="editor". An id selector works in one and silently does nothing in the
  // other.
  ok(/\.rich-text-editor \.editor-content/.test(panel), 'selects the editor some other way');
  ok(!/getElementById\('editor'\)|getElementById\('post-content'\)/.test(panel), 'selects the editor by id');
});

check('applying to the body SYNCS the hidden textarea', () => {
  // Without it the change is visible, the author carries on, and it is gone
  // after save.
  ok(/syncEditorSurface/.test(panel), 'the body edit would not be saved');
});

check('the suggestion is shown as TEXT and applied only on a second press', () => {
  ok(/output\.value = json\.data\.text/.test(panel), 'the suggestion is not shown as text');
  ok(/applyBtn\.addEventListener/.test(panel), 'there is no separate apply step');
  // Nothing may write a field on the response path.
  const runBlock = panel.slice(panel.indexOf("runBtn.addEventListener"), panel.indexOf('// The panel stays hidden'));
  ok(!/writeField\(/.test(runBlock), 'the answer is applied automatically');
});

check('no inline handler and no inline style — the admin CSP has neither', () => {
  ok(!/onclick=/i.test(code(panel)), 'inline handler');
  ok(!/\sstyle="/.test(code(panel)), 'inline style');
});

check('the panel hides itself when no assistant is configured', () => {
  // A control that can only ever fail is worse than no control.
  ok(/if \(!json\?\.data\?\.live\) return;/.test(panel), 'it shows without a provider');
  ok(/class="hidden/.test(panel), 'it does not start hidden');
});

check('the cost is stated on the screen, not buried', () => {
  ok(/costs you/i.test(panel), 'nothing tells the operator this spends their credit');
});

if (failures.length) {
  console.error(`\n✗ ai-tasks: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ ai-tasks: ${passed} passed`);
