import { __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import {
  __setR1FenceLiftAfterDropHookForTests,
  __setR1ReceiptFinalizeHookForTests,
} from '../../src/core/r1-governed-migration.ts';

__setEmbedTransportForTests(async ({ values }: { values: unknown[] }) => ({
  embeddings: values.map(() => new Array<number>(768).fill(0.001)),
  usage: { tokens: 0 },
}) as any);

if (process.env.R1_TEST_FAIL_AFTER_FENCE_DROP === '1') {
  __setR1FenceLiftAfterDropHookForTests(() => {
    throw new Error('INJECTED_POST_DROP_FAILURE');
  });
}

if (process.env.R1_TEST_FAIL_BEFORE_RECEIPT_FINALIZE === '1') {
  __setR1ReceiptFinalizeHookForTests(() => {
    throw new Error('INJECTED_RECEIPT_FINALIZE_FAILURE');
  });
}
