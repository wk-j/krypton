import { BUILTIN_ACTIONS, loadActions, saveActions } from './actions.js';

const list = document.querySelector('#list');

function row(action = { id: '', label: '', template: '' }) {
  const wrap = document.createElement('div');
  wrap.className = 'action';
  wrap.innerHTML = `
    <input class="id" placeholder="id (unique key)" value="${escapeAttr(action.id)}" />
    <input class="label" placeholder="label" value="${escapeAttr(action.label)}" />
    <textarea class="template" placeholder="prompt template">${escapeText(action.template)}</textarea>
    <button class="secondary remove">Remove</button>
  `;
  wrap.querySelector('.remove').addEventListener('click', () => wrap.remove());
  return wrap;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s) {
  return String(s).replace(/</g, '&lt;');
}

function render(actions) {
  list.innerHTML = '';
  for (const action of actions) list.appendChild(row(action));
}

function collect() {
  const actions = [];
  for (const el of list.querySelectorAll('.action')) {
    const id = el.querySelector('.id').value.trim();
    const label = el.querySelector('.label').value.trim();
    const template = el.querySelector('.template').value;
    if (id && label && template) actions.push({ id, label, template });
  }
  return actions;
}

function status(text) {
  const el = document.querySelector('#status');
  el.textContent = text;
  setTimeout(() => (el.textContent = ''), 2000);
}

document.querySelector('#add').addEventListener('click', () => list.appendChild(row()));
document.querySelector('#save').addEventListener('click', async () => {
  const actions = collect();
  if (actions.length === 0) {
    status('need at least one valid action');
    return;
  }
  await saveActions(actions);
  status('saved');
});
document.querySelector('#reset').addEventListener('click', async () => {
  await saveActions(BUILTIN_ACTIONS);
  render(BUILTIN_ACTIONS);
  status('reset to defaults');
});

loadActions().then(render);
