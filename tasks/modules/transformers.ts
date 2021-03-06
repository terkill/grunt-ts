/// <reference path="../../defs/tsd.d.ts"/>
/// <reference path="./interfaces.d.ts"/>

import fs = require('fs');
import path = require('path');
import grunt = require('grunt');
import _str = require('underscore.string');
import _ = require('underscore');
import os = require('os');
import utils = require('./utils');

// Setup when transformers are triggered
var currentTargetFiles: string[];
var currentTargetDirs: string[];


// Based on name
// if a filename matches we return a filepath
// If a foldername matches we return a folderpath
function getImports(currentFilePath: string, name: string, targetFiles: string[], targetDirs: string[], getIndexIfDir = true): string[] {
    var files = [];

    // Test if any filename matches 
    var targetFile = _.find(targetFiles, (targetFile) => {
        return path.basename(targetFile) === name
            || path.basename(targetFile, '.d.ts') === name
            || path.basename(targetFile, '.ts') === name;

    });
    if (targetFile) {
        files.push(targetFile);
    }

    // It might be worthwhile to cache this lookup
    // i.e. have a 'foldername':folderpath map passed in

    // Test if dirname matches
    var targetDir = _.find(targetDirs, (targetDir) => {
        return path.basename(targetDir) === name;
    });
    if (targetDir) {
        var possibleIndexFilePath = path.join(targetDir, 'index.ts');
        // If targetDir has an index file AND this is not that file then 
        // use index.ts instead of all the files in the directory
        if (getIndexIfDir
            && fs.existsSync(possibleIndexFilePath)
            && path.relative(currentFilePath, possibleIndexFilePath) !== '') {
            files.push(path.join(targetDir, 'index.ts'));
        }
        // Otherwise we lookup all the files that are in the folder
        else {
            var filesInDir = utils.getFiles(targetDir, (filename) => {
                // exclude current file
                if (path.relative(currentFilePath, filename) === '') { return true; }

                return path.extname(filename) // must have extension : do not exclude directories                
                    && (!_str.endsWith(filename, '.ts') || _str.endsWith(filename, '.d.ts'))
                    && !fs.lstatSync(filename).isDirectory(); // for people that name directories with dots
            });
            filesInDir.sort(); // Sort needed to increase reliability of codegen between runs
            files = files.concat(filesInDir);
        }
    }

    return files;
}

// Algo
// Notice that the file globs come as
// test/fail/ts/deep/work.ts
// So simply get dirname recursively till reach root '.'
function getTargetFolders(targetFiles: string[]) {
    var folders = {};
    _.forEach(targetFiles, (targetFile) => {
        var dir = path.dirname(targetFile);
        while (dir !== '.' && !(dir in folders)) {
            // grunt.log.writeln(dir);
            folders[dir] = true;
            dir = path.dirname(dir);
        }
    });
    return Object.keys(folders);
}

interface ITransformer {
    isGenerated(line: string);
    matches(line: string): string[];
    transform(sourceFile: string, config: string): string[];
    key: string;
}

class BaseTransformer {
    private static tsSignatureMatch = /\/\/\/\s*ts\:/;
    // equals sign is optional because we want to match on the signature regardless of any errors,
    // transformFiles() checks that the equals sign exists (by checking for the first matched capture group)
    // and fails if it is not found.
    private static tsTransformerMatch = '^///\\s*ts:{0}(=?)(.*)';

    private match: RegExp;
    private signature: string;
    signatureGenerated: string;
    syntaxError: string;
    constructor(public key: string, variableSyntax: string) {
        this.match = new RegExp(utils.format(BaseTransformer.tsTransformerMatch, key));
        this.signature = '///ts:' + key;
        this.signatureGenerated = this.signature + ':generated';
        this.syntaxError = '/// Invalid syntax for ts:' + this.key + '=' + variableSyntax + ' ' + this.signatureGenerated;
    }

    isGenerated(line: string): boolean {
        return _str.contains(line, this.signatureGenerated);
    }

    matches(line: string): string[] {
        return line.match(this.match);
    }

    static containsTransformSignature(line: string): boolean {
        return BaseTransformer.tsSignatureMatch.test(line);
    }
}

// This is a separate class from BaseTransformer to make it easier to add non import/export transforms in the future
class BaseImportExportTransformer extends BaseTransformer implements ITransformer {

    private template: (data?: { filename: string; pathToFile: string }) => string;
    private getIndexIfDir: boolean;
    private removeExtensionFromFilePath: boolean;

    constructor(public key: string,
        variableSyntax: string,
        template: (data?: { filename: string; pathToFile: string }) => string,
        getIndexIfDir: boolean,
        removeExtensionFromFilePath: boolean) {
        super(key, variableSyntax);
        this.template = template;
        this.getIndexIfDir = getIndexIfDir;
        this.removeExtensionFromFilePath = removeExtensionFromFilePath;
    }

    transform(sourceFile: string, templateVars: string): string[] {
        var result = [];
        if (templateVars) {
            var vars = templateVars.split(',');
            var requestedFileName = vars[0].trim();
            var requestedVariableName = (vars.length > 1 ? vars[1].trim() : null);
            var sourceFileDirectory = path.dirname(sourceFile);
            var imports = getImports(sourceFile, requestedFileName, currentTargetFiles, currentTargetDirs, this.getIndexIfDir);
            if (imports.length) {
                _.forEach(imports, (completePathToFile) => {
                    var filename = requestedVariableName || path.basename(path.basename(completePathToFile, '.ts'), '.d');
                    // If filename is index, we replace it with dirname: 
                    if (filename.toLowerCase() === 'index') {
                        filename = path.basename(path.dirname(completePathToFile));
                    }
                    var pathToFile = utils.makeRelativePath(sourceFileDirectory,
                        this.removeExtensionFromFilePath ? completePathToFile.replace(/(?:\.d)?\.ts$/, '') : completePathToFile, true);
                    result.push(
                        this.template({ filename: filename, pathToFile: pathToFile, signatureGenerated: this.signatureGenerated })
                        + ' '
                        + this.signatureGenerated
                    );
                });
            }
            else {
                result.push('/// No file or directory matched name "' + requestedFileName + '" ' + this.signatureGenerated);
            }
        }
        else {
            result.push(this.syntaxError);
        }
        return result;
    }
}

class ImportTransformer extends BaseImportExportTransformer implements ITransformer {
    constructor() {
        super('import', '<fileOrDirectoryName>[,<variableName>]',
            _.template('import <%=filename%> = require(\'<%= pathToFile %>\');'), true, true);
    }
}

class ExportTransformer extends BaseImportExportTransformer implements ITransformer {
    constructor() {
        // This code is same as import transformer
        // One difference : we do not short circuit to `index.ts` if found
        super('export', '<fileOrDirectoryName>[,<variableName>]',
            // workaround for https://github.com/Microsoft/TypeScript/issues/512
            _.template('import <%=filename%>_file = require(\'<%= pathToFile %>\'); <%= signatureGenerated %>' + os.EOL +
                'export var <%=filename%> = <%=filename%>_file;'), false, true);
    }
}

class ReferenceTransformer extends BaseImportExportTransformer implements ITransformer {
    constructor() {
        // This code is same as export transformer
        // also we preserve .ts file extension
        super('ref', '<fileOrDirectoryName>',
            _.template('/// <reference path="<%= pathToFile %>"/>'), false, false);
    }
}

class UnknownTransformer extends BaseTransformer implements ITransformer {
    constructor() {
        super('(.*)', '');
        this.key = 'unknown';
        this.signatureGenerated = '///ts:unknown:generated';
        this.syntaxError = '/// Unknown transform ' + this.signatureGenerated;
    }

    transform(sourceFile: string, templateVars: string): string[] {
        return [this.syntaxError];
    }
}

// This code fixes the line encoding to be per os. 
// I think it is the best option available at the moment.
// I am open for suggestions
export function transformFiles(
    changedFiles: string[],
    targetFiles: string[],
    target: ITargetOptions,
    task: ITaskOptions) {

    currentTargetDirs = getTargetFolders(targetFiles);
    currentTargetFiles = targetFiles;

    ///////////////////////////////////// transformation

    var transformers: ITransformer[] = [
        new ImportTransformer(),
        new ExportTransformer(),
        new ReferenceTransformer(),
        new UnknownTransformer()
    ];

    _.forEach(changedFiles, (fileToProcess) => {
        var contents = fs.readFileSync(fileToProcess).toString().replace(/^\uFEFF/, '');

        // If no signature don't bother with this file
        if (!BaseTransformer.containsTransformSignature(contents)) {
            return;
        }

        var lines = contents.split(/\r\n|\r|\n/);
        var outputLines: string[] = [];

        for (var i = 0; i < lines.length; i++) {

            var line = lines[i];

            //// Debugging 
            // grunt.log.writeln('line'.green);
            // grunt.log.writeln(line);

            // Skip generated lines as these will get regenerated
            if (_.some(transformers, (transformer: ITransformer) => transformer.isGenerated(line))) {
                continue;
            }

            // Directive line
            if (_.some(transformers, (transformer: ITransformer) => {
                var match = transformer.matches(line);
                if (match) {
                    // The code gen directive line automatically qualifies
                    outputLines.push(line);

                    // pass transform settings to transform (match[1] is the equals sign, ensure it exists but otherwise ignore it) 
                    outputLines.push.apply(outputLines, transformer.transform(fileToProcess, match[1] && match[2] && match[2].trim()));
                    return true;
                }
                return false;
            })) {
                continue;
            }


            // Lines not generated or not directives
            outputLines.push(line);
        }
        var transformedContent = outputLines.join(os.EOL);
        if (transformedContent !== contents) {
            grunt.file.write(fileToProcess, transformedContent);
        }
    });
}
