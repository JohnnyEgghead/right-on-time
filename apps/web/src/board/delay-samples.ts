// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-43 / API-172: a board tab posts the seq of each event whose re-read it finished. The server stamps the receive time of each
// call, so calls sent one after another would make the n-th sample carry the n-1 round trips before it (F-640) and over-report the
// slowest delay on System health. A burst's samples therefore all leave at once; a missed sample is only a missed sample.
export async function postDelaySamples(seqs: readonly number[], post: (seq: number) => Promise<unknown>): Promise<void> {
  await Promise.allSettled(seqs.filter((seq) => seq > 0).map((seq) => post(seq)));
}
