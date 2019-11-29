import * as ts from 'typescript';
import { createFilter } from 'rollup-pluginutils';
import * as fs from 'fs';
import resolveId from 'resolve';
import { endsWith } from './string';
import { getDefaultOptions, readTsConfig, adjustCompilerOptions } from './options.js';
import resolveHost from './resolveHost';

const TSLIB_ID = '\0tslib';

/**
 * @typedef { import("..").RollupTypescriptOptions } RollupTypescriptOptions
 * @typedef { import("rollup").Plugin } Plugin
 */

/**
 * @param { RollupTypescriptOptions } options
 * @returns { Plugin }
 * */
export default function typescript ( options = {} ) {
	options = Object.assign( {}, options );

	const filter = createFilter(
		options.include || [ '*.ts+(|x)', '**/*.ts+(|x)' ],
		options.exclude || [ '*.d.ts', '**/*.d.ts' ] );

	delete options.include;
	delete options.exclude;

	// Allow users to override the TypeScript version used for transpilation and tslib version used for helpers.
	const typescript = options.typescript || ts;
	const tslib = options.tslib ||
		fs.readFileSync(resolveId.sync('tslib/tslib.es6.js', { basedir: __dirname }), 'utf-8' );

	delete options.typescript;
	delete options.tslib;

	// Load options from `tsconfig.json` unless explicitly asked not to.
	const tsConfig = options.tsconfig === false ?
		{ compilerOptions: {} } :
		readTsConfig( typescript, options.tsconfig );

	delete options.tsconfig;

	// Since the CompilerOptions aren't designed for the Rollup
	// use case, we'll adjust them for use with Rollup.
	adjustCompilerOptions( typescript, tsConfig.compilerOptions );
	adjustCompilerOptions( typescript, options );

	options = Object.assign( tsConfig.compilerOptions, getDefaultOptions(), options );

	// Verify that we're targeting ES2015 modules.
	const moduleType = options.module.toUpperCase();
	if ( moduleType !== 'ES2015' && moduleType !== 'ES6' && moduleType !== 'ESNEXT' && moduleType !== 'COMMONJS' ) {
		throw new Error( `rollup-plugin-typescript: The module kind should be 'ES2015' or 'ESNext, found: '${ options.module }'` );
	}

	/** @type { import('typescript').CompilerOptions } */
	let compilerOptions; // populate in buildStart hook

	return {
		name: 'typescript',

		buildStart () {
			// Get the parsed compiler options
			const parsed = typescript.convertCompilerOptionsFromJson( options, process.cwd() );

			if ( parsed.errors.length ) {
				parsed.errors.forEach( error => this.warn( `rollup-plugin-typescript: ${ error.messageText }` ) );

				this.error( `rollup-plugin-typescript: Couldn't process compiler options` );
			}

			// let typescript load inheritance chain if there are base configs
			const extendedConfig = !tsConfig.extends ?
				null :
				typescript.parseJsonConfigFileContent(tsConfig, typescript.sys, process.cwd(), parsed.options);
			if (extendedConfig && extendedConfig.errors.length) {
				extendedConfig.errors.forEach( error => this.warn( `rollup-plugin-typescript: ${ error.messageText }` ) );

				this.error( `rollup-plugin-typescript: Couldn't process compiler options` );
			}

			compilerOptions = extendedConfig ? extendedConfig.options : parsed.options;
		},

		resolveId ( importee, importer ) {
			if ( importee === 'tslib' ) {
				return TSLIB_ID;
			}

			if ( !importer ) return null;
			importer = importer.split('\\').join('/');

			const result = typescript.nodeModuleNameResolver(importee, importer, compilerOptions, resolveHost);

			if ( result.resolvedModule && result.resolvedModule.resolvedFileName ) {
				if ( endsWith( result.resolvedModule.resolvedFileName, '.d.ts' ) ) {
					return null;
				}

				return result.resolvedModule.resolvedFileName;
			}

			return null;
		},

		load ( id ) {
			if ( id === TSLIB_ID ) {
				return tslib;
			}
		},

		transform ( code, id ) {
			if ( !filter( id ) ) return null;

			const transformed = typescript.transpileModule( code, {
				fileName: id,
				reportDiagnostics: true,
				compilerOptions
			});

			// All errors except `Cannot compile modules into 'es6' when targeting 'ES5' or lower.`
			const diagnostics = transformed.diagnostics ?
				transformed.diagnostics.filter( diagnostic => diagnostic.code !== 1204 ) : [];

			let fatalError = false;

			diagnostics.forEach( diagnostic => {
				const message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

				if ( diagnostic.file ) {
					const { line, character } = diagnostic.file.getLineAndCharacterOfPosition( diagnostic.start );
					
					console.error( `${diagnostic.file.fileName}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}` );
				} else {
					console.error( `Error: ${message}` );
				}

				if ( diagnostic.category === ts.DiagnosticCategory.Error ) {
					fatalError = true;
				}
			});

			if ( fatalError ) {
				throw new Error( `There were TypeScript errors transpiling` );
			}

			return {
				code: transformed.outputText,

				// Rollup expects `map` to be an object so we must parse the string
				map: transformed.sourceMapText ? JSON.parse(transformed.sourceMapText) : null
			};
		}
	};
}
