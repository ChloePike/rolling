/*
 * Variant of ../../support/dc-runtime.js that also renders <dc-import>: the
 * tool screens open their overlay states (model picker, settings popover, run
 * confirm, result viewer) and Advanced mode through imported components.
 *
 * Inputs (set on window before this script runs):
 *   __DC_COMPONENTS__  { [name]: { template, script, defaults } }
 *   __DC_MAIN__        name of the component to render at the root
 *   __DC_PROPS__       props for the root component
 *   __DC_NAV_LABELS__  optional { from: to } label overrides for `nav`
 */
(function () {
  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      schedule();
    }
  }
  window.DCLogic = DCLogic;

  const defs = window.__DC_COMPONENTS__;
  const classes = {};
  const templates = {};
  for (const [name, def] of Object.entries(defs)) {
    classes[name] = new Function('DCLogic', def.script + '\nreturn Component;')(DCLogic);
    const tpl = document.createElement('template');
    tpl.innerHTML = def.template;
    templates[name] = tpl;
  }
  const instances = new Map();
  let counter = 0;
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      render();
    });
  };

  const evalExpr = (expr, scope) => {
    try {
      return new Function('scope', 'with (scope) { return (' + expr + '); }')(scope);
    } catch (e) {
      return undefined;
    }
  };
  const SINGLE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
  const ANY = /\{\{([\s\S]+?)\}\}/g;
  const interpolate = (text, scope) =>
    text.replace(ANY, (_, e) => {
      const v = evalExpr(e, scope);
      return v === undefined || v === null ? '' : String(v);
    });
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const helmetDone = new Set();

  function renderComponent(name, props, out) {
    const key = name + '#' + counter++;
    let inst = instances.get(key);
    const def = defs[name];
    const full = { ...(def.defaults || {}), ...props };
    if (!inst) {
      inst = new classes[name](full);
      instances.set(key, inst);
    } else {
      inst.props = full;
    }
    let vals = inst.renderVals();
    const overrides = window.__DC_NAV_LABELS__ || {};
    if (Array.isArray(vals.nav)) {
      vals = { ...vals, nav: vals.nav.map((n) => (overrides[n.label] ? { ...n, label: overrides[n.label] } : n)) };
    }
    renderNodes(templates[name].content.childNodes, vals, out, name);
  }

  function renderNodes(nodes, scope, out, owner) {
    for (const node of nodes) renderNode(node, scope, out, owner);
  }

  function renderNode(node, scope, out, owner) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(interpolate(node.textContent, scope)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'helmet') {
      if (helmetDone.has(owner)) return;
      helmetDone.add(owner);
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName.toLowerCase() === 'link') continue;
        document.head.appendChild(child.cloneNode(true));
      }
      return;
    }
    if (tag === 'sc-for') {
      const list = evalExpr(SINGLE.exec(node.getAttribute('list'))[1], scope) || [];
      const as = node.getAttribute('as');
      list.forEach((item, index) => {
        const child = Object.create(scope);
        child[as] = item;
        child.index = index;
        renderNodes(node.childNodes, child, out, owner);
      });
      return;
    }
    if (tag === 'sc-if') {
      if (evalExpr(SINGLE.exec(node.getAttribute('value'))[1], scope)) renderNodes(node.childNodes, scope, out, owner);
      return;
    }
    if (tag === 'dc-import') {
      const name = node.getAttribute('name');
      if (!defs[name]) return;
      const props = {};
      for (const attr of Array.from(node.attributes)) {
        if (attr.name === 'name' || attr.name.startsWith('hint-')) continue;
        const single = SINGLE.exec(attr.value);
        props[camel(attr.name)] = single ? evalExpr(single[1], scope) : attr.value;
      }
      renderComponent(name, props, out);
      return;
    }

    const el = node.namespaceURI === 'http://www.w3.org/2000/svg' || tag === 'svg' || node.closest?.('svg')
      ? document.createElementNS('http://www.w3.org/2000/svg', tag === 'svg' ? 'svg' : node.localName)
      : document.createElement(tag);
    for (const attr of Array.from(node.attributes)) {
      let name = attr.name;
      if (name.startsWith('hint-')) continue;
      if (name.startsWith('sc-camel-')) name = camel(name.slice('sc-camel-'.length));
      const single = SINGLE.exec(attr.value);
      if (/^on[a-z]+$/i.test(attr.name)) {
        const fn = single ? evalExpr(single[1], scope) : null;
        const ev = attr.name.slice(2).toLowerCase();
        if (typeof fn === 'function') el.addEventListener(ev === 'change' ? 'input' : ev, fn);
        continue;
      }
      if (single) {
        const v = evalExpr(single[1], scope);
        if (v === false || v === undefined || v === null) {
          if (name.startsWith('aria-')) el.setAttribute(name, 'false');
          continue;
        }
        if (name === 'value') {
          el.value = String(v);
          continue;
        }
        el.setAttribute(name, v === true ? (name.startsWith('aria-') ? 'true' : '') : String(v));
      } else {
        el.setAttribute(name, interpolate(attr.value, scope));
      }
    }
    renderNodes(node.childNodes, scope, el, owner);
    if (tag === 'textarea' && el.value === '' && node.getAttribute('value')) {
      // value was set above via property; keep it
    }
    out.appendChild(el);
  }

  function render() {
    counter = 0;
    const root = document.getElementById('dc-root');
    const frag = document.createDocumentFragment();
    renderComponent(window.__DC_MAIN__, window.__DC_PROPS__ || {}, frag);
    root.replaceChildren(frag);
  }

  render();
  window.__DC_READY__ = true;
})();
