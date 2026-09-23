/**
 * Line prompts that work typed AND piped, shared by the offline scripts.
 *
 * `readline.question()` fails on piped input: the whole of stdin arrives at
 * once, readline reaches end-of-file and closes, and the SECOND question is
 * asked of a closed interface. `reset-password` died with ERR_USE_AFTER_CLOSE
 * (having changed nothing), and `setup` was worse — its pending question never
 * resolved, the event loop emptied, and it exited 0 without writing an admin.
 *
 * Here every line is queued as it arrives and handed to the next question, and
 * a question asked after input has ended gets `null` — which the caller turns
 * into a clear "input ended" error instead of a crash or a silent success.
 * tests/cli-prompts.test.mjs drives both scripts through a pipe.
 */
import readline from 'node:readline';

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  const lines = [];
  const waiting = [];
  let ended = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()(null);
  });

  /** Resolves with the answer line, or null when input ended before one came. */
  function ask(question) {
    output.write(question);
    if (lines.length) {
      const line = lines.shift();
      if (!input.isTTY) output.write('\n'); // nothing echoed it; keep the transcript readable
      return Promise.resolve(line);
    }
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  }

  /** ask(), but a missing answer is fatal with a message naming what was missing. */
  async function require(question, what) {
    const answer = await ask(question);
    if (answer === null) {
      console.error(`\nInput ended before ${what} was given. Nothing was changed.`);
      process.exit(1);
    }
    return answer;
  }

  return { ask, require, close: () => rl.close() };
}
