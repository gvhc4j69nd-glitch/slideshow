/**
 * Tests for account identity: what counts as an email address, and what other
 * people are allowed to see of it.
 *
 * The second half matters more than it looks. An account name is now an email
 * address, and the presenter's name is sent to every screen watching the
 * slideshow — so anything that leaks the address leaks it to whoever has the
 * share code.
 */

const assert = require('assert');
const auth = require('../lib/auth.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const accepts = (value) => {
  const result = auth.validateEmail(value);
  assert.ok(!result.error, `${JSON.stringify(value)} should be accepted, got: ${result.error}`);
  return result.value;
};
const rejects = (value) => {
  const result = auth.validateEmail(value);
  assert.ok(result.error, `${JSON.stringify(value)} should have been rejected`);
};

console.log('\n— what counts as an email address —');

check('takes the addresses people actually have', () => {
  for (const address of [
    'joe@example.com',
    'joe.peffer@example.co.uk',
    'joe+vinboo@example.com',
    'j@e.io',
    "o'brien@example.com",
    'joe_peffer@sub.domain.example.com',
    'user123@example-host.com',
  ]) accepts(address);
});

check('refuses what is not an address', () => {
  for (const notAnAddress of [
    '', '   ', 'joe', 'joe@', '@example.com', 'joe@example',
    'joe @example.com', 'joe@exa mple.com', 'joe@@example.com',
    'joe@.com', 'joe@example..com', 'joe..peffer@example.com',
    'joe@-example.com', 'joe@example-.com', 'joe@example.',
    'presenter', 'handoffcheck',
  ]) rejects(notAnAddress);
});

check('refuses the shapes a naive regex lets through', () => {
  // These are the ones worth having a test for: each is a real address format
  // that a sign-up form has no business accepting.
  for (const hostile of [
    '"joe smith"@example.com',      // quoted local part
    'joe<script>@example.com',      // markup
    'joe@[192.168.0.1]',            // address literal
    'joe@example.com, eve@evil.com', // two addresses
    'joe@example.com;eve@evil.com',
    'joe\\@example.com',
  ]) rejects(hostile);
});

check('holds to the lengths the standard sets', () => {
  accepts(`${'a'.repeat(64)}@example.com`);          // the longest local part
  rejects(`${'a'.repeat(65)}@example.com`);
  rejects(`${'a'.repeat(250)}@${'b'.repeat(250)}.com`);
});

check('settles on one spelling, so an address is one account', () => {
  assert.strictEqual(accepts('  Joe.Peffer@Example.COM  '), 'joe.peffer@example.com');
  assert.strictEqual(accepts('JOE@EXAMPLE.COM'), 'joe@example.com');
});

console.log('\n— what other people get to see —');

check('a viewer is shown the name, never the address', () => {
  assert.strictEqual(auth.displayName('joe.peffer@example.com'), 'joe.peffer');
  assert.strictEqual(auth.displayName('joe+party@example.co.uk'), 'joe+party');
  // Nothing after the @ may survive: the domain is half of a contactable address.
  for (const address of ['joe@example.com', 'a@b.io', 'x+y@sub.domain.example.com']) {
    assert.ok(!auth.displayName(address).includes('@'), address);
    assert.ok(!auth.displayName(address).includes('.com'), address);
  }
});

check('accounts made before the rule still have a name', () => {
  assert.strictEqual(auth.displayName('presenter'), 'presenter');
  assert.strictEqual(auth.displayName('handoffcheck'), 'handoffcheck');
});

check('nothing missing turns into something broken', () => {
  assert.strictEqual(auth.displayName(''), '');
  assert.strictEqual(auth.displayName(null), '');
  assert.strictEqual(auth.displayName(undefined), '');
  assert.strictEqual(auth.displayName('@example.com'), '@example.com');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
