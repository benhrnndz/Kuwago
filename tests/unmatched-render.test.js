import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUnmatchedTable } from '../js/render.js';

class FakeNode {
  constructor() {
    this.hidden = true;
    this.innerHTML = '';
    this.children = [];
    this.style = {};
  }

  set textContent(value) {
    this.innerHTML = String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  appendChild(child) {
    this.children.push(child);
    if (child.children) this.innerHTML = child.children.map(node => node.innerHTML).join('');
    return child;
  }
}

function installDocument() {
  const nodes = new Map([
    ['#unmatched-body', new FakeNode()],
    ['#unmatched-empty', new FakeNode()]
  ]);

  globalThis.document = {
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    createElement() {
      return new FakeNode();
    },
    createDocumentFragment() {
      return new FakeNode();
    }
  };

  return nodes;
}

test('renders an unmatched row with status and a review-only action', () => {
  const nodes = installDocument();

  renderUnmatchedTable([{
    name: 'Outsider Account',
    liveStatus: 'on_meet',
    matched: false,
    action: 'Unmatched'
  }]);

  const html = nodes.get('#unmatched-body').innerHTML;
  assert.match(html, /Outsider Account/);
  assert.match(html, /On Meet tab/);
  assert.match(html, />Unmatched</);
  assert.doesNotMatch(html, /resolve-select/);
});
