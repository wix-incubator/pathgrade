const assert = require('assert');
const { add, subtract, multiply } = require('./calc');

assert.strictEqual(add(2, 3), 5, 'add(2, 3) should be 5');
assert.strictEqual(subtract(10, 3), 7, 'subtract(10, 3) should be 7');
assert.strictEqual(multiply(4, 3), 12, 'multiply(4, 3) should be 12');

console.log('All tests passed');
