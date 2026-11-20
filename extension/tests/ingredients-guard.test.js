const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadIngredientsGuard() {
  const sandbox = { console, RegExp, Object, Array, String, Boolean };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(extDir, 'shared', 'ingredients-guard.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'shared/ingredients-guard.js' });
  return sandbox.LQS_INGREDIENTS_GUARD;
}

test('analyzeIngredientsTrafficLight flags red risk ingredients (ЗМЖ, пальмовое масло, ММО, E250)', () => {
  const guard = loadIngredientsGuard();

  const sausages = JSON.parse(
    JSON.stringify(
      guard.analyzeIngredientsTrafficLight(
        'Мясо птицы механической обвалки, вода, крахмал картофельный, нитрит натрия E250, усилитель вкуса E621',
        'Сосиски Молочные'
      )
    )
  );
  assert.equal(sausages.level, 'red');
  assert.ok(sausages.redFlags.some((f) => f.id === 'mmo'));
  assert.ok(sausages.redFlags.some((f) => f.id === 'nitrite_benzoate'));
  assert.ok(sausages.yellowFlags.some((f) => f.id === 'msg'));
  assert.match(sausages.badgeText, /^🔴/);

  const sweets = JSON.parse(
    JSON.stringify(
      guard.analyzeIngredientsTrafficLight(
        'Сахар, заменитель молочного жира (пальмовое масло, эмульгатор лецитин), какао-порошок',
        'Сырок глазированный'
      )
    )
  );
  assert.equal(sweets.level, 'red');
  assert.ok(sweets.redFlags.some((f) => f.id === 'zmzh'));
  assert.ok(sweets.redFlags.some((f) => f.id === 'palm_oil'));
});

test('analyzeIngredientsTrafficLight flags yellow compromises and hidden sugar in fit/zero products', () => {
  const guard = loadIngredientsGuard();

  const chips = JSON.parse(
    JSON.stringify(
      guard.analyzeIngredientsTrafficLight(
        'Картофель, масло подсолнечное, глутамат натрия, мальтодекстрин, соль',
        'Чипсы со вкусом сыра'
      )
    )
  );
  assert.equal(chips.level, 'yellow');
  assert.equal(chips.redFlags.length, 0);
  assert.ok(chips.yellowFlags.some((f) => f.id === 'msg'));
  assert.ok(chips.yellowFlags.some((f) => f.id === 'syrup_maltodextrin'));
  assert.match(chips.badgeText, /^🟡/);

  const fitBar = JSON.parse(
    JSON.stringify(
      guard.analyzeIngredientsTrafficLight(
        'Овсяные хлопья, концентрат сывороточного белка, сахар, кокосовая стружка',
        'Протеиновый ПП-батончик фитнес'
      )
    )
  );
  assert.equal(fitBar.level, 'yellow');
  assert.ok(fitBar.yellowFlags.some((f) => f.id === 'hidden_sugar_in_fit'));
});

test('analyzeIngredientsTrafficLight returns green for clean ingredients and none when missing', () => {
  const guard = loadIngredientsGuard();

  const clean = JSON.parse(
    JSON.stringify(
      guard.analyzeIngredientsTrafficLight(
        'Молоко нормализованное, закваска молочнокислых микроорганизмов',
        'Творог 5%'
      )
    )
  );
  assert.equal(clean.level, 'green');
  assert.equal(clean.badgeText, '🟢 Чистый состав');
  assert.equal(clean.allFlags.length, 0);

  const missing = JSON.parse(JSON.stringify(guard.analyzeIngredientsTrafficLight('', 'Яблоки')));
  assert.equal(missing.level, 'none');
  assert.equal(missing.badgeText, '');
});
