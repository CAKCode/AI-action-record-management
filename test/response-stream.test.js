const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { pipeResponseStream } = require('../src/response-stream');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withDeadline(promise, milliseconds = 1000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Response stream test timed out')), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function consumedResponse() {
  const response = new PassThrough();
  response.resume();
  response.on('error', () => {});
  return response;
}

test('response stream idle timeout destroys a source that makes no progress', async () => {
  const source = new PassThrough();
  const response = consumedResponse();
  let idleTimeoutCount = 0;
  const completed = pipeResponseStream(response, source, {
    idleTimeoutMs: 50,
    onIdleTimeout: () => { idleTimeoutCount += 1; },
  });

  source.write('first chunk');
  await withDeadline(completed);

  assert.equal(idleTimeoutCount, 1);
  assert.equal(source.destroyed, true);
  assert.equal(response.destroyed, true);
});

test('response stream progress refreshes the timeout without limiting total duration', async () => {
  const source = new PassThrough();
  const response = consumedResponse();
  let idleTimeoutCount = 0;
  const completed = pipeResponseStream(response, source, {
    idleTimeoutMs: 80,
    onIdleTimeout: () => { idleTimeoutCount += 1; },
  });

  for (let index = 0; index < 5; index += 1) {
    source.write(`chunk-${index}\n`);
    await sleep(40);
  }
  source.end('final\n');
  await withDeadline(completed);

  assert.equal(idleTimeoutCount, 0);
  assert.equal(source.destroyed, true);
  assert.equal(response.writableEnded, true);
});

test('response close cancels an idle timeout before the source close settles', async () => {
  const source = new PassThrough();
  const response = consumedResponse();
  let idleTimeoutCount = 0;
  const completed = pipeResponseStream(response, source, {
    idleTimeoutMs: 50,
    onIdleTimeout: () => { idleTimeoutCount += 1; },
  });

  source.write('first chunk');
  response.destroy();
  await withDeadline(completed);
  await sleep(75);

  assert.equal(idleTimeoutCount, 0);
  assert.equal(source.destroyed, true);
});
