import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translationsOf } from '../src/i18n';
import { EXTERNAL_NAME, LabelStore, labelFor } from '../src/labels';
import { makeTempHome, MemoryMemento, type TempHome } from './helpers';

let tmp: TempHome;
before(() => { tmp = makeTempHome('labels'); });
after(() => tmp.restore());

const make = (): { memento: MemoryMemento; store: LabelStore } => {
  const memento = new MemoryMemento();
  return { memento, store: new LabelStore(memento, 'claude.labels') };
};

describe('LabelStore get/set/remove', () => {
  test('returns undefined when not set', () => {
    assert.equal(make().store.get('default'), undefined);
  });
  test('readable after set; stored as a Record keyed by account name', async () => {
    const { memento, store } = make();
    await store.set('default', '工作号');
    await store.set('test1', 'backup');
    assert.equal(store.get('default'), '工作号');
    assert.equal(store.get('test1'), 'backup');
    assert.deepEqual(memento.get('claude.labels'), { default: '工作号', test1: 'backup' });
  });
  test('set undefined / empty string / same as name → removes the entry', async () => {
    const { memento, store } = make();
    await store.set('a', 'x');
    await store.set('b', 'y');
    await store.set('a', undefined);
    assert.equal(store.get('a'), undefined);
    await store.set('b', 'b');
    assert.equal(store.get('b'), undefined);
    await store.set('c', '');
    assert.deepEqual(memento.get('claude.labels'), {});
  });
  test('remove deletes the alias', async () => {
    const { store } = make();
    await store.set('a', 'x');
    await store.remove('a');
    assert.equal(store.get('a'), undefined);
  });
  test('set does not mutate the object stored in the memento', async () => {
    const { memento, store } = make();
    await store.set('a', 'x');
    const stored = memento.get<Record<string, string>>('claude.labels');
    await store.set('b', 'y');
    assert.deepEqual(stored, { a: 'x' });
  });
});

describe('names that are Object.prototype members', () => {
  test('constructor / toString / __proto__ without an alias → undefined, labelFor returns the name', () => {
    const { store } = make();
    for (const name of ['constructor', 'toString', '__proto__']) {
      assert.equal(store.get(name), undefined, name);
      assert.equal(labelFor(name, store), name);
    }
  });
  test('aliases can be set, read and removed; stored as own keys', async () => {
    const { memento, store } = make();
    for (const name of ['constructor', 'toString', '__proto__']) await store.set(name, `alias-${name}`);
    for (const name of ['constructor', 'toString', '__proto__']) {
      assert.equal(store.get(name), `alias-${name}`);
      assert.equal(labelFor(name, store), `alias-${name}`);
    }
    const stored = memento.get<Record<string, string>>('claude.labels') ?? {};
    assert.deepEqual(Object.keys(stored).sort(), ['__proto__', 'constructor', 'toString']);
    assert.equal(Object.getPrototypeOf(stored), Object.prototype, '__proto__ must not replace the prototype');
    await store.remove('__proto__');
    await store.remove('constructor');
    assert.equal(store.get('__proto__'), undefined);
    assert.equal(store.get('constructor'), undefined);
    assert.equal(store.get('toString'), 'alias-toString');
  });
  test('__proto__ alias survives the Memento JSON round-trip', async () => {
    const { memento, store } = make();
    await store.set('__proto__', 'p');
    await store.set('a', 'x');
    const reloaded = new MemoryMemento();
    await reloaded.update('claude.labels', JSON.parse(JSON.stringify(memento.get('claude.labels'))));
    const store2 = new LabelStore(reloaded, 'claude.labels');
    assert.equal(store2.get('__proto__'), 'p');
    assert.equal(store2.get('a'), 'x');
    await store2.set('b', 'y');
    assert.equal(store2.get('__proto__'), 'p', 'kept when another alias is written');
  });
  test('validate does not treat inherited members as existing labels', () => {
    const { store } = make();
    assert.equal(store.validate('constructor', 'default', [{ name: 'default', label: 'default' }]), undefined);
  });
});

describe('validate', () => {
  const existing = [
    { name: 'main', label: 'work' },
    { name: 'test1', label: 'test1' },
  ];
  const { store } = make();
  test('valid → undefined (after trim)', () => {
    assert.equal(store.validate('  fresh  ', 'main', existing), undefined);
    assert.equal(store.validate('work', 'main', existing), undefined, 'same as its own current alias is allowed');
  });
  test('blank', () => {
    assert.equal(store.validate('   ', 'main', existing), 'Enter a display name');
  });
  test('longer than 32 characters', () => {
    assert.equal(store.validate('a'.repeat(32), 'main', existing), undefined);
    assert.equal(store.validate('a'.repeat(33), 'main', existing), 'Display name can be at most 32 characters');
  });
  test('the limit counts grapheme clusters, not UTF-16 code units', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';   // one grapheme, 8 code units
    assert.equal(store.validate(family.repeat(32), 'main', existing), undefined);
    assert.equal(store.validate(family.repeat(33), 'main', existing), 'Display name can be at most 32 characters');
    assert.equal(store.validate('e\u0301'.repeat(32), 'main', existing), undefined);
    assert.equal(store.validate('\u4E2D'.repeat(33), 'main', existing), 'Display name can be at most 32 characters');
  });
  test('contains a line break', () => {
    assert.equal(store.validate('a\nb', 'main', existing), 'Display name cannot contain line breaks');
  });
  test('reserved names: the sentinel and every localized external-directory name', () => {
    assert.equal(store.validate(EXTERNAL_NAME, 'main', existing), `Cannot use the reserved name ${EXTERNAL_NAME}`);
    assert.equal(store.validate('External directory', 'main', existing), 'Cannot use the reserved name External directory');
    assert.equal(store.validate('外部目录', 'main', existing), 'Cannot use the reserved name 外部目录');
  });
  test('same as another account name / label', () => {
    assert.equal(store.validate('test1', 'main', existing), 'Same as an existing account name');
    assert.equal(store.validate('work', 'test1', existing), "Same as an existing account's display name");
  });
  test('duplicates are compared case-insensitively; the account itself is still excluded', () => {
    assert.equal(store.validate('TEST1', 'main', existing), 'Same as an existing account name');
    assert.equal(store.validate('Work', 'test1', existing), "Same as an existing account's display name");
    assert.equal(store.validate('WORK', 'main', existing), undefined);
    assert.equal(store.validate('Main', 'main', existing), undefined);
  });
});

describe('labelFor', () => {
  test('uses the alias if set, otherwise the name', async () => {
    const { store } = make();
    assert.equal(labelFor('a', store), 'a');
    await store.set('a', 'work');
    assert.equal(labelFor('a', store), 'work');
    assert.equal(labelFor('other', store), 'other');
  });
  test('default is always shown as is, even with an alias stored by an earlier version', async () => {
    const { store } = make();
    await store.set('default', 'work');
    assert.equal(labelFor('default', store), 'default');
  });
  test('external row gets the localized name, never the sentinel', () => {
    assert.equal(labelFor(EXTERNAL_NAME, make().store), 'External directory');
  });
});

describe('labels in zh-cn', () => {
  after(() => setLocale('en'));
  test('validate messages and the external row name follow the locale', () => {
    setLocale('zh-cn');
    const { store } = make();
    assert.equal(store.validate('   ', 'default', []), '请输入显示名');
    assert.equal(store.validate('a'.repeat(33), 'default', []), '显示名最多 32 个字符');
    assert.equal(store.validate('External directory', 'default', []), '不能使用保留名 External directory');
    assert.equal(labelFor(EXTERNAL_NAME, store), '外部目录');
  });
});

test('external-directory labels are reserved in every supported language', () => {
  const { store } = make();
  for (const label of translationsOf('account.external')) {
    assert.notEqual(store.validate(label, 'work', []), undefined, label);
  }
});
