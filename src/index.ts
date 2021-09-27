import path from 'path'
import fs from 'fs'
import resolveFile from 'resolve-file'
import postcss from 'postcss'
import cssModules from 'postcss-modules'
import temp from 'temp'
import { TextDecoder } from 'util'
import { OnLoadArgs, OnLoadResult, OnResolveArgs, OnResolveResult, PluginBuild } from 'esbuild'

import { getModule, isCSSModule } from './helpers'

export interface PluginOptions {
  extract?: boolean
  cssModuleMatch?: RegExp
  postcss?: unknown[]
}

export interface RenderOptions {
  sassOptions?: {}
  stylusOptions?: {}
  lessOptions?: {}
}

const LOAD_TEMP_NAMESPACE = 'load_temp_namespace'
const LOAD_STYLE_NAMESPACE = 'load_style_namespace'
const styleFilter = /.\.(css|sass|scss|less|styl)$/

export const renderStyle = async (filePath, options: RenderOptions = {}) => {
  const { ext } = path.parse(filePath)

  if (ext === '.css') {
    return await fs.promises.readFile(filePath)
  }

  if (ext === '.sass' || ext === '.scss') {
    const sassOptions = options.sassOptions || {}
    const sass = getModule('sass')
    return sass.renderSync({ ...sassOptions, file: filePath }).css.toString('utf-8')
  }

  if (ext === '.styl') {
    const stylusOptions = options.sassOptions || {}
    const stylus = getModule('stylus')
    const source = await fs.promises.readFile(filePath)
    return await stylus.render(new TextDecoder().decode(source), { ...stylusOptions, filename: filePath })
  }

  if (ext === '.less') {
    const lestOptions = options.lessOptions || {}
    const less = getModule('less')
    const source = await fs.promises.readFile(filePath)
    return (await less.render(new TextDecoder().decode(source), { ...lestOptions, filename: filePath })).css
  }

  throw new Error(`Can't render this style '${ext}'.`)
}

const handleCSSModules = (mapping) => cssModules({
  getJSON: (_, json) => {
    mapping.data = JSON.stringify(json, null, 2)
  }
})

const onStyleResolve = async (args: OnResolveArgs): Promise<OnResolveResult> => {
  const { namespace, resolveDir } = args
  let fullPath = resolveFile(args.path, {})
  if (!fullPath) fullPath = path.resolve(args.resolveDir, args.path)

  if (namespace === LOAD_STYLE_NAMESPACE) {
    return {
      path: fullPath,
      namespace: LOAD_TEMP_NAMESPACE,
      pluginData: { resolveDir }
    }
  }

  return {
    path: fullPath,
    namespace: LOAD_STYLE_NAMESPACE
  }
}

const onTempLoad = async (args: OnLoadArgs): Promise<OnLoadResult> => {
  const { pluginData } = args
  const data = await fs.promises.readFile(args.path)

  return {
    resolveDir: pluginData.resolveDir,
    contents: data,
    loader: 'css'
  }
}

const onStyleLoad = (options) => async (args: OnLoadArgs): Promise<OnLoadResult> => {
  // { extract: false } is for SSR since we only need the css mapping and not the actual css file
  const extract = options.extract === undefined ? true : options.extract
  const cssModulesMatch = options.cssModulesMatch || /\.module\./
  const isCSSModule = args.path.match(cssModulesMatch)

  // Render whatever style currently on the loader .css, .sass, .styl, .less
  let css = await renderStyle(args.path)

  let mapping = { data: {} }
  let plugins = options.postcss || []
  let injectMapping = false
  let contents = ''

  // Match file with extension .module. => styles.module.sass
  if (isCSSModule) {
    // We have css module file so we include the postcss-modules plugin
    plugins = [handleCSSModules(mapping), ...plugins]
    injectMapping = true
  }

  // Makes no sense to process postcss if we don't have any plugins
  if (plugins.length > 0) {
    css = (await postcss(plugins).process(css, { from: args.path })).css

    // Inject classnames mapping for css modules
    if (injectMapping) contents += `export default ${mapping.data};`
  }

  // Write new css to a temporary file
  if (extract) {
    const writestream = temp.createWriteStream({ suffix: '.css' })
    writestream.write(css)
    writestream.end()

    // Inject import "new url path" so esbuild can resolve a new css file
    contents += `import ${JSON.stringify(writestream.path)};`
  }

  return {
    resolveDir: path.dirname(args.path), // Keep resolveDir for onTempLoad anything resolve inside temp file must be resolve using source dir
    contents: contents
  }
}

export default (options: PluginOptions = {}) => ({
  name: 'esbuild-postcss-plugin',
  setup: (build: PluginBuild) => {
    // Resolve all css or other style here
    build.onResolve({ filter: styleFilter }, onStyleResolve)

    // New temp files from rendered css must evaluated
    build.onLoad({ filter: /.*/, namespace: LOAD_TEMP_NAMESPACE }, onTempLoad)

    // Render css with CSS Extensions / Preprocessors and PostCSS
    build.onLoad({ filter: /.*/, namespace: LOAD_STYLE_NAMESPACE }, onStyleLoad(options))
  }
})