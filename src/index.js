import SymbolTree from 'symbol-tree';
import * as types from './node-types.js';
import * as tags from './tags.js';
import * as fns from './functions.js';
import * as filters from './filters.js';
import fsLoader from './fs.js';

export const TAG = /^\s*([^\s]+)\s*([^]+)$/;

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

class Sontag {

	constructor(cwd, options = {}) {
		this.cwd = cwd;

		this.options = {
			loader: fsLoader,
			...options
		};

		/*
			Default scope
		 */
		this.global_scope = {};
		Object.keys(fns).forEach(fn => {
			this.global_scope[fn] = fns[fn].bind(this);
		});


		let _filters = {
			...filters,
			'default': filters['_default']
		};
		delete _filters._default;
		this.global_scope.__filters__ = {};
		Object.keys(_filters).forEach(f => {
			this.global_scope.__filters__[f] = _filters[f].bind(this);
		});

		// Add built-in tags
		this.tags = {};
		Object.values(tags).forEach(tag => {
			this.addTag(tag);
		});
	}

	parse(contents, f = '(String)') {

		// Basic error logging
		let line = 1, line_count = 0, loc = () => `[${f}:${line - line_count}]`;

		let { TSTART, CSTART, ESTART, TEND, CEND, EEND } = tokens;

		/* 
			Split the input by relevant tokens, 
			and obtain an iterator.
		*/
		let regex = new RegExp(`(${Object.values(tokens).join('|')})`, 'g');
		let it = contents.split(regex)[Symbol.iterator]();

		/*
			The AST tree
		 */
		let tree = new SymbolTree();

		/* 
			Root of the AST tree.
		*/
		let $root = new types.Root();

		/*
			The current insertion point.
			This is initially the root of the tree,
			but changes when we enter tags that have
			opening / closing statements.
		 */
		let $head = $root;

		// Result of the current iteration
		let is = it.next();

		// Keeps the value of the current item
		let item;

		/*
			The scope stack.
			Possible values:
			- content
			- tag
			- expression
			- comment
		*/
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

			if (item === TSTART) {
				if (scope !== 'content') {
					throw new Error(`${loc()} Unexpected ${item}`);
				}
				stack.push('tag');
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
				let res = item.match(TAG);
				if (!res) {
					throw new Error(`${loc()} Missing tag`);
				}
				let [ str, tagName, signature ] = res;
				let t = this.tag(tagName);
				if (!t) {
					throw new Error(`${loc()} Unknown tag ${tagName}`);
				}

				let [ ctor, type ] = t;
				let node = new ctor(tagName, type, signature.trim());
				
				if (type === types.$tag_start) {
					tree.appendChild($head, node);
					if (!node.singular) {
						$head = node;
					}
				} else if (type === types.$tag_end) {
					let parent = tree.parent($head);
					if ($head.constructor !== ctor || !parent) {
						throw new Error(`${loc()} Can't close ${$head} with ${node}`);
					}
					if ($head.$typeof === types.$tag_start) {
						$head = parent;
					} else if ($head.$typeof === types.$tag_inside) {
						$head =  tree.parent(parent);
					}
				} else if (type === types.$tag_inside) {
					let parent = tree.parent($head);
					if ($head.constructor !== ctor || !parent) {
						throw new Error(`${loc()} Can't include ${node} in ${$head}`);
					}
					tree.appendChild($head, node);
					$head = node;
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

	async apply(tree, $root, scope, condition) {
		let res = await $root.render(scope, this, async (outer_scope, condition) => {
			let it = tree.childrenIterator($root);
			let is = it.next();
			let node, res = [];
			while (!is.done) {
				node = is.value;
				res.push(await this.apply(tree, node, outer_scope, condition));
				is = it.next();
			}
			return res.join('');
		});
		if (typeof res === 'function') {
			return res(condition);
		}
		return res;
	}

	async render(template, context) {
		let contents = await this.options.loader(template, this.cwd);
		return this.renderString(contents, context);
	}

	async renderString(contents, context) {
		let scope = Object.assign(Object.create(this.global_scope), context);
		let { tree, $root } = this.parse(contents);
		return this.apply(tree, $root, scope);
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

	addFilter(name, fn) {
		this.global_scope.__filters__[name] = fn;
	}
}

export default Sontag;
export { types };