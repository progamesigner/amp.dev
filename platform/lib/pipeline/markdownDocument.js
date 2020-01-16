/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const writeFile = require('write');
const yaml = require('js-yaml');
const {Signale} = require('signale');
const utils = require('@lib/utils');
const SlugGenerator = require('@lib/utils/slugGenerator');

// Inline marker used by Grow to determine if there should be TOC
const TOC_MARKER = '[TOC]';
// It doesn't make sense to give every MarkdownDocument their own logger instance
// therefore have one shared one
const LOG = new Signale({'scope': 'Markdown Documents'});

// This expression matches a {% raw %}...{% endraw %} block
const JINJA2_RAW_BLOCK = /\{%\s*raw\s*%\}(?:(?!\{%\s*endraw\s*%\})[\s\S])*\{%\s*endraw\s*%\}/;

// This expression matches source code blocks. fenced blocks are converted to this syntax
const SOURCECODE_BLOCK = /\[\s*sourcecode[^\]]*\][\s\S]*?\[\s*\/\s*sourcecode\s*\]/;

// we search for ALL code blocks, and at the same time for raw blocks
// to ensure we do not match something that belongs to different code blocks
// or we add raw tags to existing raw blocks
const MARKDOWN_BLOCK_PATTERN = new RegExp(
    JINJA2_RAW_BLOCK.source +
    '|' +
    SOURCECODE_BLOCK.source +
    '|' +
    /`[^`]*`/.source, 'g');

// Inside code blocks we search for mustache expressions
// The constant 'server_for_email' and expressions with a dot or a bracket are not considered mustache
// TODO: Avoid the need to distinguish between mustache and jinja2
const MUSTACHE_PATTERN = new RegExp(
    '(' +
    JINJA2_RAW_BLOCK.source +
    '|' +
    /\{\{(?!\s*server_for_email\s*\}\})(?:[\s\S]*?\}\})?/.source +
    ')', 'g');

// Matches tags used for SSR
const NUNJUCKS_PATTERN = /\[(?:%|=|#)|(?:%|=|#)\]/g;

// This pattern will find relative urls.
// It will als match source code blocks to skip them and not replace any links inside.
const RELATIVE_LINK_PATTERN = new RegExp(
    // skip sourcecode tag in markdown
    SOURCECODE_BLOCK.source +
    '|' +
    // skip inline source marker
    /`[^`]*`/.source +
    '|' +
    // find <a href=""> link tag:
    /<a(?:\s+[^>]*)?\shref\s*=\s*"([^":\{?#]+)(?:[?#][^\)]*)?"/.source +
    '|' +
    // find markdown link block [text](../link):
    /\[[^\]]+\]\(([^:\)\{?#]+)(?:[?#][^\)]*)?\)/.source
    , 'g');

// This pattern will find the text for markdown titles skipping explicit anchors.
const TITLE_ANCHOR_PATTERN =
    /^(#+)[ \t]+(.*?)(<a[ \t]+name=[^>]*><\/a>)?((?:.(?!<a[ \t]+name))*?)$/mg;

// Matches a block of frontmatter delimited by ---
const FRONTMATTER_PATTERN = /^---\r?\n.*\r?\n---\r?\n/ms;

// Matches a HTML comment in the form of <!-- Comment. -->
const HTML_COMMENT_PATTERN = /<!--.*-->/gms;

// Matches the next paragraph after a markdown headline
// const PARAGRAPH_PATTERN = /^[^\[#<]*\S\s{2}/gm;
const PARAGRAPH_PATTERN = /(?<=# .*\s{1,2}).*/gm;

class MarkdownDocument {
  constructor(path, contents) {
    this.contents = contents;
    this._frontmatter = MarkdownDocument.extractFrontmatter(contents);

    if (!this.teaser.text) {
      LOG.warn(`Auto extracting teaser text for ${path}`);
      this.teaser = {text: MarkdownDocument.extractTeaserText(contents)};
      if (!this.teaser.text) {
        LOG.error(`Failed to extract teaser text for ${path}`);
      }
    }

    this.toc = contents.includes(TOC_MARKER) ? false : true;
    this.path = path;
  }

  set toc(active) {
    // Remove markers from document as inline TOCs are not supported
    this._contents = this._contents.replace(TOC_MARKER, '');

    this._frontmatter['toc'] = active;
    this._toc = active;
  }

  get path() {
    return this._path;
  }

  set path(path) {
    this._path = path;
  }

  get importURL() {
    return this._importURL;
  }

  set importURL(importURL) {
    this._importURL = importURL;
  }

  get title() {
    return this._frontmatter['$title'] || this._frontmatter['title'];
  }

  set title(title) {
    this._frontmatter['$title'] = title;
  }

  set order(order) {
    this._frontmatter['$order'] = order;
  }

  get category() {
    return this._frontmatter['$category@'] || this._frontmatter['$category'];
  }

  set category(category) {
    this._frontmatter['$category@'] = category;
  }

  /**
   * Returns the formats supported by this version of the component.
   */
  get formats() {
    return this._frontmatter['formats'] || [];
  }

  set formats(formats) {
    this._frontmatter['formats'] = formats;
  }

  get teaser() {
    return this._frontmatter['teaser'] || {};
  }

  set teaser(teaser) {
    this._frontmatter['teaser'] = Object.assign(this._frontmatter['teaser'] || {}, teaser);
  }

  set servingPath(path) {
    this._frontmatter['$path'] = path;
    this._frontmatter['$localization'] = {path: '/{locale}' + path};
  }

  get contents() {
    return this._contents;
  }

  set contents(contents) {
    this.originalContents = contents;

    this._contents = contents.trim();
    this._contents = this._contents.replace(FRONTMATTER_PATTERN, '');

    this._contents = MarkdownDocument.replaceDelimiters(this._contents);
    this._contents = MarkdownDocument.rewriteCalloutToTip(this._contents);
    this._contents = MarkdownDocument.rewriteCodeBlocks(this._contents);
    this._contents = MarkdownDocument.escapeMustacheTags(this._contents);
    this._contents = MarkdownDocument.escapeNunjucksTags(this._contents);
  }

  /**
   * Matches all paragraphs inside a markdown document excluding tags
   * like [tip], [sourcecode] et al.
   * @param  {String} contents [description]
   * @return {String}          [description]
   */
  static extractTeaserText(contents) {
    contents = contents.replace(HTML_COMMENT_PATTERN, '');

    const paragraphs = contents.match(PARAGRAPH_PATTERN);
    if (paragraphs && paragraphs[0]) {
      let text = paragraphs[0].replace(/\n/g, ' ').trim();
      // Strip out all possible HTML tags
      text = text.replace(/<\/?[^>]+(>|$)/g, '');
      // Unwrap back ticks
      text = text.replace(/`(.+)`/g, '$1');
      // And unwrap possible markdown links
      text = text.replace(/\[(.+)\]\(.+\)/g, '$1');

      if (text) {
        return text;
      }
    }

    LOG.error(`Could not parse a teaser text from "${contents.substr(0, 500)}..."`);
    return '';
  }

  /**
   * Checks for a frontmatter block in a string of content and tries to
   * parse it to its JavaScript equivalent
   * @param  {String} contents
   * @return {Object}
   */
  static extractFrontmatter(contents) {
    contents = contents.trim();

    // Check if the document defines its own frontmatter already
    if (contents.startsWith('---')) {
      let frontmatter = contents.match(FRONTMATTER_PATTERN);
      if (!frontmatter) {
        LOG.warn(`Unparseable frontmatter "${contents.substr(0, 50)} ..."`);
      } else {
        frontmatter = frontmatter[0];

        // Strip out limiters from frontmatter string to be able to parse it
        // and then use it as initial fill for the actual properties
        frontmatter = frontmatter.replace(/---/g, '');
        try {
          return yaml.safeLoad(frontmatter);
        } catch (e) {
          LOG.error(`Failed to parse frontmatter "${frontmatter} ..."`);
        }
      }
    }

    return {
      '$title': '',
    };
  }

  /**
   * Replaces --- (<hr>) with *** as former one collides with
   * Grow's way of extracting the frontmatter
   * @param  {String} contents
   * @return {String}          The rewritten input
   */
  static replaceDelimiters(contents) {
    return contents.replace(/\n---\n/gm, '\n***\n');
  }

  /**
   * Escapes nunjucks tags to not interfer with SSR
   * @param  {String} contents
   * @return {String}          The rewritten input
   */
  static escapeNunjucksTags(contents) {
    return contents.replace(NUNJUCKS_PATTERN, (tag) => {
      // TODO(matthiasrohmer): Raw tags for nunjucks do not match.
      // See: github.com/ampproject/amp.dev#2865
      return `{{'[% raw %]'}}${tag}{{'{% endraw %}'}}`;
    });
  }

  /**
   * Escapes mustache style tags in code blocks to not interfer with Jinja2
   * @param  {String} contents
   * @return {String}          The rewritten input
   */
  static escapeMustacheTags(contents) {
    return contents.replace(MARKDOWN_BLOCK_PATTERN, (block) => {
      // check for mustache tags only if we have no raw block
      if (!block.startsWith('{')) {
        block = block.replace(
            MUSTACHE_PATTERN,
            (part) => {
              // again, only if it is a mustache block wrap it with raw
              if (part.startsWith('{{')) {
                part = '{% raw %}' + part + '{% endraw %}';
              }
              return part;
            });
      }
      return block;
    });
  }

  /**
   * Replaces the {% call callout ... %} syntax with the new BBCode styled
   * [tip]...[/type] shortcode while mapping the types to the new ones
   * @param  {String} contents
   * @return {String}          The rewritten input
   */
  static rewriteCalloutToTip(contents) {
    const CALLOUT_PATTERN = /{% call callout\('.*?', type='(.*?)'\) %}(.*?){% endcall %}/gs;
    const AVAILABLE_CALLOUT_TYPES = {
      'note': 'note',
      'read': 'read-on',
      'caution': 'important',
      'success': 'success',
    };

    contents = contents.replace(CALLOUT_PATTERN, (match, type, text) => {
      return `[tip type="${AVAILABLE_CALLOUT_TYPES[type]}"]\n${text}\n[/tip]`;
    });

    return contents;
  }

  /**
   * Rewrites code fences to python-markdown syntax.
   * @param  {String} contents
   * @return {String}          The rewritten content
   */
  static rewriteCodeBlocks(contents) {
    // Rewrite code blocks in fence syntax
    contents =
      contents.replace(/(```)(([A-z-]*)\n)(((?!```)[\s\S])+)(```[\t ]*\n)/gm,
          (match, p1, p2, p3, p4) => {
            return '[sourcecode' + (p3 ? ':' + p3 : ':none') + ']\n' + p4 + '[/sourcecode]\n';
          });

    return contents;
  }

  /**
   * Rewrite relative links and append the given base path to them
   * @param  {String} base
   */
  rewriteRelativePaths(base) {
    if (!base.endsWith('/')) {
      base += '/';
    }
    this._contents = this._contents.replace(RELATIVE_LINK_PATTERN,
        (match, hrefLink, markdownLink) => {
          const link = hrefLink || markdownLink;
          if (!link) {
            return match;
          }
          return match.replace(link, base + link);
        });
  }

  /**
   * Removes the first heading to avoid double titles
   * @return {String}          The rewritten input
   */
  stripInlineTitle() {
    const TITLE_PATTERN = /^#{1}\s.+/m;
    /#.*/m;
    this._contents = this._contents.replace(TITLE_PATTERN, '');
    return true;
  }

  /**
   *Adds explicit anchors for titels in github notation
   */
  addExplicitAnchors() {
    const slugGenerator = new SlugGenerator();
    this._contents = this._contents.replace(TITLE_ANCHOR_PATTERN,
        (line, hLevel, headlineStart, anchor, headlineEnd) => {
          let headline = headlineStart + headlineEnd;
          headline = headline.replace(/`(.*?)`|\[(.*?)\]\(.*?\)|<.*?>|&[^\s]+?;/g,
              (line, code, linktext) => {
                if (code || linktext) {
                  return code || linktext;
                }
                return '';
              });
          const slug = slugGenerator.generateSlug(headline);
          // Even if we have an anchor the slug generator has to know all the headlines.
          if (anchor) {
            return line;
          }
          return `${hLevel} ${headlineStart}${headlineEnd} <a name="${slug}"></a>`;
        });
    return true;
  }

  /**
   * Writes the file to the specified path or the relative one
   * if none is set
   * @return {Promise}
   */
  save(path) {
    let content = '';
    const frontmatter = `---\n${yaml.safeDump(this._frontmatter, {'skipInvalid': true})}---\n\n`;
    content += frontmatter;

    /**
    * check if file is imported and if so add a comment in order to inform that
    * the file should not be changed in the amp.dev/docs - repro
    */
    if (this._importURL) {
      const importedText = `<!--
This file is imported from ${this.importURL}.
Please do not change this file.
If you have found a bug or an issue please
have a look and request a pull request there.
-->

`;
      content += importedText;
    }

    content += this._contents;

    path = path ? path : this._path;
    return writeFile(path, content).then(() => {
      LOG.success(`Saved ${path.replace(utils.project.paths.ROOT, '~')}`);
    }).catch((e) => {
      LOG.error(`Couldn't save ${path.replace(utils.project.paths.ROOT, '~')}`, e);
    });
  }
}

module.exports = MarkdownDocument;
