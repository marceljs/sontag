import { readFile } from 'fs';
import { join } from 'path';
import SymbolTree from 'symbol-tree';
import * as types from './node-types';
import { parse } from 'acorn';

const tokens = {
	TSTART: '{%',
	TEND: '%}',
	ESTART: '{{',
	EEND: '}}',
	CSTART: '{#',
	CEND: '#}'
};

const isToken = Object.keys(tokens).reduce(
	(acc, key) => (acc[tokens[key]] = true, acc), {}
);

class Feuille {

	constructor(cwd, options = {}) {
		this.cwd = cwd;
		this.options = {
			...options
		};

		this.tags = {};

		// add built-in tags
		Object.values(types).forEach(ctor => {
			if (ctor.prototype instanceof types.Tag) {
				this.addTag(ctor);
			}
		});
	}

	parse(contents, f = '(String)') {

		// Basic error logging
		let line = 1, line_count = 0, loc = () => `[${f}:${line - line_count}]`;

		let { TSTART, CSTART, ESTART, TEND, CEND, EEND } = tokens;

		let regex = new RegExp(`(${Object.values(tokens).join('|')})`, 'g');
		let it = contents.split(regex)[Symbol.iterator]();

		let tree = new SymbolTree();
		let $root = new types.Root();
		let $head = $root;

		let is = it.next(), item;

		// The scope stack		
		let stack = ['content'];

		while (!is.done) {

			item = is.value;

			line_count = (item.match(/\n/g) || []).length;
			line += line_count;

			// Prepare next iteration
			is = it.next();

			let scope = stack[stack.length - 1];

			if (item === CSTART) {
				stack.push('comment');
				continue;
			}

			if (item === CEND) {
				if (scope === 'comment') {
					stack.pop();			
				} else {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				continue;
			}

			// While we're in the comment's scope,
			// ignore everything that's not a CSTART / CEND.
			if (scope === 'comment') continue;

			if (item === ESTART) {
				if (scope !== 'content') {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				stack.push('expression');
				continue;
			}

			if (item === EEND) {
				if (scope === 'expression') {
					stack.pop();
				} else {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				continue;
			}

			if (item === TSTART) {
				if (scope !== 'content') {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				stack.push('tag');
				continue;
			}

			if (item === TEND) {
				if (scope === 'tag') {
					stack.pop();
				} else {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				continue;
			}

			// Static content
			
			if (scope === 'content') {
				tree.appendChild($head, new types.Text(item));
				continue;
			}

			if (scope === 'expression') {
				tree.appendChild($head, new types.Expression(item));
				continue;
			}

			if (scope === 'tag') {
				let res = item.match(/^\s*([^\s]+)\s*(.*?)\s*$/);
				if (!res) {
					throw new Error(`${loc()} Missing tag`);
				}
				let [ str, tagName, signature ] = res;
				let t = this.tag(tagName);
				if (!t) {
					throw new Error(`${loc()} Unknown tag ${tagName}`);
				}

				let [ ctor, type ] = t;

				let node = new ctor(tagName, type, signature);
				
				if (type === types.$tag_start) {
					tree.appendChild($head, node);
					if (!ctor.singular) {
						$head = node;
					}
				} else if (type === types.$tag_end) {
					let parent = tree.parent($head);
					if ($head.constructor !== ctor || !parent) {
						throw new Error(`Can't close ${$head} with ${node}`);
					}
					$head = parent;
				} else if (type === types.$tag_inside) {
					// todo (if/elseif/else)
				}

				continue;
			}
		};

		if (stack.length !== 1) {
			throw new Error(`${loc()} Unexpected end of template`);
		}

		if ($head !== $root) {
			throw new Error(`${$head} left unclosed`);
		}

		return {
			tree,
			$root
		};
	} 

	async apply(tree, $root, ctx) {
		let res = $root.eval();
		let it = tree.childrenIterator($root);
		let is = it.next();
		let node;
		while (!is.done) {
			node = is.value;
			res += await this.apply(tree, node, ctx);
			is = it.next();
		}
		return res;
	}

	async render(template, ctx = {}) {
		let file = await readFile(join(cwd, template), 'utf8');
		let { tree, $root } = this.parse(file, template);
		return this.apply(tree, $root, ctx);
	}

	renderSync(template) {}

	async renderString(str, ctx = {}) {
		let { tree, $root } = this.parse(str);
		return this.apply(tree, $root, ctx);
	}

	renderStringSync(str) {

	}

	tag(tagName) {
		return this.tags[tagName];
	}

	addTag(ctor) {
		ctor.tagNames.forEach(tagName => {
			this.tags[tagName] = [ctor, types.$tag_start];
			if (!ctor.singular) {
				this.tags[`end${tagName}`] = [ctor, types.$tag_end];
			}
		});

		(ctor.insideTagNames || []).forEach(tagName => {
			this.tags[tagName] = [ctor, types.$tag_inside];
		});
	}
}

export default Feuille;