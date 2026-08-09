/**
 * Small XML reader for Office Open XML parts.
 *
 * DOMParser would do this in the browser, but a self-contained parser keeps
 * the deck code runnable (and testable) under Node too. OOXML is machine
 * generated and well-formed, so this only needs elements, attributes, text,
 * comments and CDATA — no DTDs or entity declarations.
 *
 * Element names keep their namespace prefix ("p:sp", "a:off"), which is how
 * the rest of the deck code refers to them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Xml = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(text) {
    if (text.indexOf('&') === -1) return text;
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
    });
  }

  function parseAttributes(source) {
    const attrs = {};
    const re = /([\w:.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = re.exec(source))) {
      attrs[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4]);
    }
    return attrs;
  }

  /** Parse a document into {name, attrs, children, text}. Returns the root element. */
  function parse(text) {
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    let i = 0;

    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt === -1) break;

      if (lt > i) {
        const chunk = text.slice(i, lt);
        if (/\S/.test(chunk)) {
          const top = stack[stack.length - 1];
          top.text += decodeEntities(chunk);
        }
      }

      // Declarations, comments and CDATA.
      if (text.startsWith('<?', lt)) {
        i = text.indexOf('?>', lt);
        i = i === -1 ? text.length : i + 2;
        continue;
      }
      if (text.startsWith('<!--', lt)) {
        i = text.indexOf('-->', lt);
        i = i === -1 ? text.length : i + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt);
        const body = text.slice(lt + 9, end === -1 ? text.length : end);
        stack[stack.length - 1].text += body;
        i = end === -1 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith('<!', lt)) {
        i = text.indexOf('>', lt);
        i = i === -1 ? text.length : i + 1;
        continue;
      }

      const gt = text.indexOf('>', lt);
      if (gt === -1) break;
      const inner = text.slice(lt + 1, gt);

      if (inner[0] === '/') {
        if (stack.length > 1) stack.pop();
        i = gt + 1;
        continue;
      }

      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const space = body.search(/[\s/]/);
      const name = space === -1 ? body : body.slice(0, space);
      const node = {
        name,
        attrs: space === -1 ? {} : parseAttributes(body.slice(space)),
        children: [],
        text: '',
      };

      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = gt + 1;
    }

    return root.children[0] || root;
  }

  /** First direct child with the given name. */
  function child(node, name) {
    if (!node) return null;
    for (const c of node.children) if (c.name === name) return c;
    return null;
  }

  /** All direct children with the given name. */
  function children(node, name) {
    if (!node) return [];
    return node.children.filter((c) => c.name === name);
  }

  /** First descendant with the given name, depth-first. */
  function find(node, name) {
    if (!node) return null;
    for (const c of node.children) {
      if (c.name === name) return c;
      const deeper = find(c, name);
      if (deeper) return deeper;
    }
    return null;
  }

  /** Every descendant with the given name, in document order. */
  function findAll(node, name, out = []) {
    if (!node) return out;
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      findAll(c, name, out);
    }
    return out;
  }

  /** Follow a chain of child names, e.g. path(sp, 'p:spPr', 'a:xfrm', 'a:off'). */
  function path(node, ...names) {
    let current = node;
    for (const name of names) {
      current = child(current, name);
      if (!current) return null;
    }
    return current;
  }

  const attr = (node, name, fallback = null) =>
    (node && node.attrs[name] !== undefined ? node.attrs[name] : fallback);

  /** Concatenated text of a node and everything under it. */
  function allText(node) {
    if (!node) return '';
    let out = node.text || '';
    for (const c of node.children) out += allText(c);
    return out;
  }

  return { parse, child, children, find, findAll, path, attr, allText };
});
