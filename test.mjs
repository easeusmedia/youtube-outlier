// node test.mjs  — one runnable check for the parts that can actually break.
// The transcript half hits YouTube for real; no API key needed.
import assert from 'assert';
import { parseDuration, median, fetchTranscript, buildPdf } from './server.js';

assert.equal(parseDuration('PT1H2M3S'), 3723);
assert.equal(parseDuration('PT45S'), 45);
assert.equal(parseDuration('PT12M'), 720);
assert.equal(parseDuration('P1DT2H'), 93600);
assert.equal(parseDuration(''), 0);

assert.equal(median([1, 2, 3]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(median([]), 0);
assert.equal(median([5, 1, 3]), 3); // must sort numerically, not lexically
console.log('✓ duration + median');

const t = await fetchTranscript('jNQXAC9IVRw');
assert.ok(t.text.length > 50, 'transcript came back empty');
assert.ok(!/\w[A-Z][a-z]/.test(t.text.slice(0, 200)) || t.text.includes(' '), 'cues must be space-joined');
console.log('✓ transcript:', t.lang, t.text.slice(0, 60) + '…');

await assert.rejects(() => fetchTranscript('00000000000'), 'a dead video id should throw, not hang');
console.log('✓ missing captions throw');

const pdf = await buildPdf({
  channel: { title: 'Test Channel' },
  items: [
    { id: 'jNQXAC9IVRw', title: 'Me at the zoo', views: 1234, publishedAt: '2005-04-24T00:00:00Z', text: t.text, auto: false },
    { id: 'xxxxxxxxxxx', title: 'हिन्दी शीर्षक — unicode check', views: 9, publishedAt: '2024-01-01T00:00:00Z', error: 'no captions available' },
  ],
});
assert.ok(pdf.slice(0, 5).toString() === '%PDF-', 'not a PDF');
assert.ok(pdf.length > 3000, 'PDF suspiciously small');
console.log('✓ pdf:', (pdf.length / 1024).toFixed(1) + 'KB');

console.log('\nall good');
