'use strict';

const { Queue } = require('bullmq');

const QUEUE_NAME = 'stock-updates';

function createQueue(redis) {
  return new Queue(QUEUE_NAME, { connection: redis });
}

async function enqueueStockUpdate(queue, payload) {
  return queue.add('update-stock', payload, {
    attempts: 5,
    backoff:  { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail:     false,
  });
}

module.exports = { createQueue, enqueueStockUpdate, QUEUE_NAME };
