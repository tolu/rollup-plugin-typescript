/** @typedef { import("rollup").Plugin } Plugin */
/** @typedef { import("..").RollupTypescriptOptions } RollupTypescriptOptions */

const assert = require( 'assert' );
const rollup = require( 'rollup' );
/** @type { (options?: RollupTypescriptOptions ) => Plugin } */
const typescript = require( '..' );
const path = require('path');
const commonjs = require('rollup-plugin-commonjs');

/** @param { RollupTypescriptOptions } [options] */
async function bundle (main, options) {
	return rollup.rollup({
		input: main,
		plugins: [typescript(options)]
	});
}

const getOutputFromGenerated = generated => generated.output[0];

async function getCodeFromBundle (bundle) {
	return getOutputFromGenerated(await bundle.generate({ format: 'esm' })).code;
}

/** @param { RollupTypescriptOptions } [options] */
async function getCode ( main, options ) {
	return getCodeFromBundle(await bundle(main, options));
}

async function evaluateBundle ( bundle ) {
	const module = { exports: {} };
	new Function(
		'module',
		'exports',
		getOutputFromGenerated(await bundle.generate({ format: 'cjs' })).code
	)( module, module.exports );
	return module.exports;
}

async function evaluate ( main, options ) {
	return evaluateBundle(await bundle(main, options));
}

describe( 'rollup-plugin-typescript', () => {
	beforeEach(() => process.chdir(__dirname));

	it( 'runs code through typescript', async () => {
		const code = await getCode( 'sample/basic/main.ts' );

		assert.ok( code.indexOf( 'number' ) === -1, code );
		assert.ok( code.indexOf( 'const' ) === -1, code );
	});

	it( 'ignores the declaration option', () => {
		return bundle( 'sample/basic/main.ts', { declaration: true });
	});

	it( 'throws for unsupported module types', async () => {
		let caughtError = null;
		try {
			await bundle( 'sample/basic/main.ts', { module: 'ES5' } );
		} catch (error) {
			caughtError = error;
		}

		assert.ok(!!caughtError, 'Throws an error.');
		assert.ok(caughtError.message.indexOf( 'The module kind should be \'ES2015\' or \'ESNext, found: \'ES5\'' ) !== -1,
			`Unexpected error message: ${caughtError.message}`);
	});

	it( 'ignores case of module types', async () => {
		return bundle( 'sample/basic/main.ts', { module: 'eSnExT' } );
	});

	it( 'handles async functions', async () => {
		const wait = await evaluate('sample/async/main.ts');
		return wait(3);
	});

	it( 'does not duplicate helpers', async () => {
		const code = await getCode('sample/dedup-helpers/main.ts');

		// The `__extends` function is defined in the bundle.
		assert.ok( code.indexOf( 'function __extends' ) > -1, code );

		// No duplicate `__extends` helper is defined.
		assert.equal( code.indexOf( '__extends$1' ), -1, code );
	});

	it( 'transpiles `export class A` correctly', async () => {
		const bundled = await bundle( 'sample/export-class-fix/main.ts' );

		const code = await getCodeFromBundle(bundled);
		assert.ok( code.indexOf( 'export { A, B };' ) !== -1, code );

		const { A, B } = await evaluateBundle(bundled);
		const aInst = new A();
		const bInst = new B();
		assert.ok(aInst instanceof A);
		assert.ok(bInst instanceof B);


	});

	it( 'transpiles ES6 features to ES5 with source maps', async () => {
		const code = await getCode( 'sample/import-class/main.ts' );

		assert.equal( code.indexOf( '...' ), -1, code );
		assert.equal( code.indexOf( '=>' ), -1, code );
	});

	it( 'reports diagnostics and throws if errors occur during transpilation', async () => {
		let caughtError = null;
		try {
			await bundle( 'sample/syntax-error/missing-type.ts' );
		} catch (error) {
			caughtError = error;
		}

		assert.ok(!!caughtError, 'throws an error');
		assert.ok( caughtError.message.indexOf( 'There were TypeScript errors transpiling' ) !== -1,
			`Unexpected error message: ${caughtError.message}`);
	});

	it( 'works with named exports for abstract classes', async () => {
		const code = await getCode('sample/export-abstract-class/main.ts' );
		assert.ok( code.length > 0, code );
	});

	it( 'should use named exports for classes', async () => {
		assert.equal( (await evaluate( 'sample/export-class/main.ts' )).foo, 'bar' );
	});

	it( 'supports overriding the TypeScript version', async () => {
		const result = await evaluate('sample/overriding-typescript/main.ts', {
			// Don't use `tsconfig.json`
			tsconfig: false,

			// test with a mocked version of TypeScript
			typescript: fakeTypescript({
				version: '1.8.0-fake',

				transpileModule: () => {
					// Ignore the code to transpile. Always return the same thing.
					return {
						outputText: 'export default 1337;',
						diagnostics: [],
						sourceMapText: JSON.stringify({ mappings: '' })
					};
				}
			})
		});

		assert.equal( result, 1337 );
	});

	it( 'supports overriding tslib', async () => {
		const code = await evaluate('sample/overriding-tslib/main.ts', {
			tslib: 'export const __extends = (Main, Super) => Main.myParent = Super'
		});

		assert.equal( code.myParent.baseMethod(), 'base method' );
	});

	it( 'should not resolve .d.ts files', async () => {
		const imports = (await bundle( 'sample/dts/main.ts' )).cache.modules[0].dependencies;
		assert.deepEqual( imports, [ 'an-import' ] );
	});

	it( 'should transpile JSX if enabled', async () => {
		const code = await getCode( 'sample/jsx/main.tsx', { jsx: 'react' });

		assert.notEqual( code.indexOf( 'var __assign = ' ), -1,
			'should contain __assign definition' );

		const usage = code.indexOf( 'React.createElement("span", __assign({}, props), "Yo!")' );

		assert.notEqual( usage, -1, 'should contain usage' );
	});

	it( 'automatically loads tsconfig.json from the current directory', async () => {
		process.chdir('sample/tsconfig-jsx');
		const code = await getCode( 'main.tsx');

		const usage = code.indexOf( 'React.createElement("span", __assign({}, props), "Yo!")' );
		assert.notEqual( usage, -1, 'should contain usage' );
	});

	it( 'should support extends property in tsconfig', async () => {
		process.chdir('sample/tsconfig-extends');
		const code = await getCode( 'main.tsx');

		const usage = code.indexOf( 'React.createElement("span", __assign({}, props), "Yo!")' );
		assert.notEqual( usage, -1, 'should contain usage' );
	});

	it( 'allows specifying a path for tsconfig.json', async () => {
		const code = await getCode( 'sample/tsconfig-jsx/main.tsx',
			{tsconfig: path.resolve(__dirname, 'sample/tsconfig-jsx/tsconfig.json')});

		const usage = code.indexOf( 'React.createElement("span", __assign({}, props), "Yo!")' );
		assert.notEqual( usage, -1, 'should contain usage' );
	});

	it( 'throws if tsconfig cannot be found', async () => {
		let caughtError = null;
		try {
			await bundle( 'sample/tsconfig-jsx/main.tsx', {tsconfig: path.resolve(__dirname, 'does-not-exist.json')} );
		} catch (error) {
			caughtError = error;
		}

		assert.ok(!!caughtError, 'Throws an error.');
		assert.ok(caughtError.message.indexOf( 'Could not find specified tsconfig.json' ) !== -1,
			`Unexpected error message: ${caughtError.message}`);
	});

	it('should throw on bad options', () => {
		return bundle('does-not-matter.ts', {
			foo: 'bar'
		}).then(() => {
			throw new Error('plugin did not throw');
		}).catch(err => assert.equal(err.message, 'rollup-plugin-typescript: Couldn\'t process compiler options'));
	});

	it( 'prevents errors due to conflicting `sourceMap`/`inlineSourceMap` options', () => {
		return bundle( 'sample/overriding-typescript/main.ts', {
			inlineSourceMap: true
		});
	});

	it ( 'should not fail if source maps are off', () => {
		return bundle( 'sample/overriding-typescript/main.ts', {
			inlineSourceMap: false,
			sourceMap: false
		});
	});

	it( 'does not include helpers in source maps', async () => {
		const bundled = await bundle( 'sample/dedup-helpers/main.ts', {
			sourceMap: true
		});

		const map = getOutputFromGenerated(await bundled.generate({
			format: 'es',
			sourcemap: true
		})).map;

		assert.ok( map.sources.every( source => source.indexOf( 'tslib' ) === -1) );
	});

	it( 'should allow a namespace containing a class', async () => {
		const MODE = (await evaluate('sample/export-namespace-export-class/test.ts')).MODE.MODE;
		const mode = new MODE();

		assert.ok(mode instanceof MODE);
	});

	it( 'should allow merging an exported function and namespace', async () => {
		const f = (await evaluate('sample/export-fodule/main.ts')).test;

		assert.equal(f(), 0);
		assert.equal(f.foo, "2");
	});

	it('supports dynamic imports', async () => {
		const code = await getCodeFromBundle(await rollup.rollup({
			input: 'sample/dynamic-imports/main.ts',
			inlineDynamicImports: true,
			plugins: [typescript()]
		}));
		assert.notEqual( code.indexOf( 'console.log(\'dynamic\')' ), -1 );
	});

	it('supports CommonJS imports when the output format is CommonJS', async () => {
		const output = await evaluateBundle(await rollup.rollup({
			input: 'sample/commonjs-imports/main.ts',
			plugins: [typescript({module: 'CommonJS'}), commonjs({extensions: ['.ts', '.js']})]
		}));
		assert.equal(output, 'exported from commonjs');
	});
});

function fakeTypescript ( custom ) {
	return Object.assign({
		transpileModule () {
			return {
				outputText: '',
				diagnostics: [],
				sourceMapText: JSON.stringify({ mappings: '' })
			};
		},

		convertCompilerOptionsFromJson ( options ) {
			[
				'include',
				'exclude',
				'typescript',
				'tslib',
				'tsconfig'
			].forEach( option => {
				if ( option in options ) {
					throw new Error( 'unrecognized compiler option "' + option + '"' );
				}
			});

			return {
				options,
				errors: []
			};
		}
	}, custom);
}
