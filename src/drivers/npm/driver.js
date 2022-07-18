// const os = require('os')
const fs = require('fs')
const dns = require('dns').promises
const path = require('path')
const http = require('http')
const https = require('https')
// eslint-disable-next-line no-unused-vars
const { title } = require('process')
const puppeteer = require('puppeteer')
// eslint-disable-next-line no-unused-vars
const { IBM_LZ77 } = require('adm-zip/util/constants')
const Wappalyzer = require('./wappalyzer')

const { setTechnologies, setCategories, analyze, analyzeManyToMany, resolve } =
  Wappalyzer

const {
  // CHROMIUM_BIN,
  CHROMIUM_DATA_DIR,
  CHROMIUM_WEBSOCKET,
} = process.env

const chromiumArgs = [
  '--single-process',
  '--no-sandbox',
  '--no-zygote',
  '--disable-gpu',
  '--ignore-certificate-errors',
  '--allow-running-insecure-content',
  '--disable-web-security',
  `--user-data-dir=${CHROMIUM_DATA_DIR || '/tmp/chromium'}`,
]

const extensions = /^([^.]+$|\.(asp|aspx|cgi|htm|html|jsp|php)$)/

const categories = JSON.parse(
  fs.readFileSync(path.resolve(`${__dirname}/categories.json`))
)

let technologies = {}

for (const index of Array(27).keys()) {
  const character = index ? String.fromCharCode(index + 96) : '_'

  technologies = {
    ...technologies,
    ...JSON.parse(
      fs.readFileSync(
        path.resolve(`${__dirname}/technologies/${character}.json`)
      )
    ),
  }
}

setTechnologies(technologies)
setCategories(categories)

const xhrDebounce = []

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getJs(page, technologies = Wappalyzer.technologies) {
  return page.evaluate((technologies) => {
    return technologies
      .filter(({ js }) => Object.keys(js).length)
      .map(({ name, js }) => ({ name, chains: Object.keys(js) }))
      .reduce((technologies, { name, chains }) => {
        chains.forEach((chain) => {
          chain = chain.replace(/\[([^\]]+)\]/g, '.$1')

          const value = chain
            .split('.')
            .reduce(
              (value, method) =>
                value &&
                value instanceof Object &&
                Object.prototype.hasOwnProperty.call(value, method)
                  ? value[method]
                  : '__UNDEFINED__',
              window
            )

          if (value !== '__UNDEFINED__') {
            technologies.push({
              name,
              chain,
              value:
                typeof value === 'string' || typeof value === 'number'
                  ? value
                  : !!value,
            })
          }
        })

        return technologies
      }, [])
  }, technologies)
}

function analyzeJs(js, technologies = Wappalyzer.technologies) {
  return js
    .map(({ name, chain, value }) => {
      return analyzeManyToMany(
        technologies.find(({ name: _name }) => name === _name),
        'js',
        { [chain]: [value] }
      )
    })
    .flat()
}

// inspect nodes here
function getDom(page, technologies = Wappalyzer.technologies) {
  return page.evaluate((technologies) => {
    return technologies
      .filter(({ dom }) => dom && dom.constructor === Object)
      .reduce((technologies, { name, dom }) => {
        const toScalar = (value) =>
          typeof value === 'string' || typeof value === 'number'
            ? value
            : !!value

        Object.keys(dom).forEach((selector) => {
          let nodes = []

          try {
            nodes = document.querySelectorAll(selector)
          } catch (error) {
            // Continue
          }

          if (!nodes.length) {
            return
          }

          dom[selector].forEach(({ exists, text, properties, attributes }) => {
            nodes.forEach((node) => {
              if (exists) {
                technologies.push({
                  name,
                  selector,
                  exists: '',
                })
              }

              if (text) {
                const value = node.textContent.trim()

                if (value) {
                  technologies.push({
                    name,
                    selector,
                    text: value,
                  })
                }
              }

              if (properties) {
                Object.keys(properties).forEach((property) => {
                  if (Object.prototype.hasOwnProperty.call(node, property)) {
                    const value = node[property]

                    if (typeof value !== 'undefined') {
                      technologies.push({
                        name,
                        selector,
                        property,
                        value: toScalar(value),
                      })
                    }
                  }
                })
              }

              if (attributes) {
                Object.keys(attributes).forEach((attribute) => {
                  if (node.hasAttribute(attribute)) {
                    const value = node.getAttribute(attribute)

                    technologies.push({
                      name,
                      selector,
                      attribute,
                      value: toScalar(value),
                    })
                  }
                })
              }
            })
          })
        })

        return technologies
      }, [])
  }, technologies)
}

// avalyses the dom, using regex to find matches to a technology
function analyzeDom(dom, technologies = Wappalyzer.technologies) {
  return dom
    .map(({ name, selector, exists, text, property, attribute, value }) => {
      const technology = technologies.find(({ name: _name }) => name === _name)

      if (typeof exists !== 'undefined') {
        return analyzeManyToMany(technology, 'dom.exists', {
          [selector]: [''],
        })
      }

      if (typeof text !== 'undefined') {
        return analyzeManyToMany(technology, 'dom.text', {
          [selector]: [text],
        })
      }

      if (typeof property !== 'undefined') {
        return analyzeManyToMany(technology, `dom.properties.${property}`, {
          [selector]: [value],
        })
      }

      if (typeof attribute !== 'undefined') {
        return analyzeManyToMany(technology, `dom.attributes.${attribute}`, {
          [selector]: [value],
        })
      }
    })
    .flat()
}

function get(url, options = {}) {
  const timeout = options.timeout || 10000

  if (['http:', 'https:'].includes(url.protocol)) {
    const { get } = url.protocol === 'http:' ? http : https

    return new Promise((resolve, reject) =>
      get(
        url,
        {
          rejectUnauthorized: false,
          headers: {
            'User-Agent': options.userAgent,
          },
        },
        (response) => {
          if (response.statusCode >= 400) {
            return reject(
              new Error(`${response.statusCode} ${response.statusMessage}`)
            )
          }

          response.setEncoding('utf8')

          let body = ''

          response.on('data', (data) => (body += data))
          response.on('error', (error) => reject(new Error(error.message)))
          response.on('end', () => resolve(body))
        }
      )
        .setTimeout(timeout, () =>
          reject(new Error(`Timeout (${url.href}, ${timeout}ms)`))
        )
        .on('error', (error) => reject(new Error(error.message)))
    )
  } else {
    throw new Error(`Invalid protocol: ${url.protocol}`)
  }
}

class Driver {
  constructor(options = {}) {
    this.options = {
      batchSize: 5,
      debug: false,
      delay: 500,
      htmlMaxCols: 2000,
      htmlMaxRows: 3000,
      maxDepth: 3,
      maxUrls: 10,
      maxWait: 50000,
      recursive: false,
      probe: false,
      proxy: false,
      noScripts: false,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.97 Safari/537.36',
      extended: false,
      ...options,
    }

    this.options.debug = Boolean(+this.options.debug)
    this.options.recursive = Boolean(+this.options.recursive)
    this.options.probe = Boolean(+this.options.probe)
    this.options.delay = parseInt(this.options.delay, 10)
    this.options.maxDepth = parseInt(this.options.maxDepth, 10)
    this.options.maxUrls = parseInt(this.options.maxUrls, 10)
    this.options.maxWait = parseInt(this.options.maxWait, 10)
    this.options.htmlMaxCols = parseInt(this.options.htmlMaxCols, 10)
    this.options.htmlMaxRows = parseInt(this.options.htmlMaxRows, 10)
    this.options.noScripts = Boolean(+this.options.noScripts)
    this.options.extended = Boolean(+this.options.extended)

    if (this.options.proxy) {
      chromiumArgs.push(`--proxy-server=${this.options.proxy}`)
    }

    this.destroyed = false
  }

  async init() {
    this.log('Launching browser...')

    try {
      if (CHROMIUM_WEBSOCKET) {
        this.browser = await puppeteer.connect({
          ignoreHTTPSErrors: true,
          acceptInsecureCerts: true,
          browserWSEndpoint: CHROMIUM_WEBSOCKET,
        })
      } else {
        this.browser = await puppeteer.launch({
          ignoreHTTPSErrors: true,
          acceptInsecureCerts: true,
          args: chromiumArgs,
          // executablePath: CHROMIUM_BIN,
        })
      }

      this.browser.on('disconnected', async () => {
        this.log('Browser disconnected')

        if (!this.destroyed) {
          try {
            await this.init()
          } catch (error) {
            this.log(error.toString())
          }
        }
      })
    } catch (error) {
      throw new Error(error.toString())
    }
  }

  async destroy() {
    this.destroyed = true

    if (this.browser) {
      try {
        await sleep(1)

        await this.browser.close()

        this.log('Browser closed')
      } catch (error) {
        throw new Error(error.toString())
      }
    }
  }

  open(url, headers = {}) {
    return new Site(url.split('#')[0], headers, this)
  }

  log(message, source = 'driver') {
    if (this.options.debug) {
      // eslint-disable-next-line no-console
      console.log(`log | ${source} |`, message)
    }
  }
}

class Site {
  constructor(url, headers = {}, driver) {
    ;({
      options: this.options,
      browser: this.browser,
      init: this.initDriver,
    } = driver)

    this.options.headers = {
      ...this.options.headers,
      ...headers,
    }

    this.driver = driver

    try {
      this.originalUrl = new URL(url)
    } catch (error) {
      throw new Error(error.toString())
    }

    this.analyzedUrls = {}
    this.analyzedXhr = {}
    this.analyzedRequires = {}
    this.detections = []

    this.listeners = {}

    this.pages = []

    this.cache = {}

    this.probed = false

    this.inspects = {}

    this.destroyed = false

    this.totalSize = 0
  }

  log(message, source = 'driver', type = 'log') {
    if (this.options.debug) {
      // eslint-disable-next-line no-console
      console[type](`${type} | ${source} |`, message)
    }

    this.emit(type, { message, source })
  }

  error(error, source = 'driver') {
    this.log(error, source, 'error')
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = []
    }

    this.listeners[event].push(callback)
  }

  emit(event, params) {
    if (this.listeners[event]) {
      return Promise.allSettled(
        this.listeners[event].map((listener) => listener(params))
      )
    }
  }

  promiseTimeout(
    promise,
    fallback,
    errorMessage = 'Operation took too long to complete',
    maxWait = Math.min(this.options.maxWait, 1000)
  ) {
    let timeout = null

    if (!(promise instanceof Promise)) {
      return Promise.resolve(promise)
    }

    return Promise.race([
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          clearTimeout(timeout)

          const error = new Error(errorMessage)

          error.code = 'PROMISE_TIMEOUT_ERROR'

          if (fallback !== undefined) {
            this.error(error)

            resolve(fallback)
          } else {
            reject(error)
          }
        }, maxWait)
      }),
      promise.then((value) => {
        clearTimeout(timeout)

        return value
      }),
    ])
  }

  // make request to url
  async goto(url) {
    if (this.destroyed) {
      return
    }

    // Return when the URL is a duplicate or maxUrls has been reached
    if (this.analyzedUrls[url.href]) {
      return []
    }

    this.log(`Navigate to ${url}`)

    this.analyzedUrls[url.href] = {
      status: 0,
    }

    if (!this.browser) {
      await this.initDriver()

      if (!this.browser) {
        throw new Error('Browser closed')
      }
    }

    let page

    try {
      page = await this.browser.newPage()

      if (!page || page.isClosed()) {
        throw new Error('Page did not open')
      }
    } catch (error) {
      error.message += ` (${url})`

      this.error(error)

      await this.initDriver()

      page = await this.browser.newPage()
    }

    this.pages.push(page)

    page.setJavaScriptEnabled(!this.options.noScripts)

    page.setDefaultTimeout(this.options.maxWait)

    await page.setRequestInterception(true)

    await page.setUserAgent(this.options.userAgent)

    page.on('dialog', (dialog) => dialog.dismiss())

    page.on('error', (error) => {
      error.message += ` (${url})`

      this.error(error)
    })

    let responseReceived = false

    // on xhr call the url
    page.on('request', async (request) => {
      try {
        if (request.resourceType() === 'xhr') {
          let hostname

          try {
            ;({ hostname } = new URL(request.url()))
          } catch (error) {
            request.abort('blockedbyclient')

            return
          }

          if (!xhrDebounce.includes(hostname)) {
            xhrDebounce.push(hostname)

            setTimeout(async () => {
              xhrDebounce.splice(xhrDebounce.indexOf(hostname), 1)

              this.analyzedXhr[url.hostname] =
                this.analyzedXhr[url.hostname] || []

              if (!this.analyzedXhr[url.hostname].includes(hostname)) {
                this.analyzedXhr[url.hostname].push(hostname)

                await this.onDetect(url, analyze({ xhr: hostname }))
              }
            }, 1000)
          }
        }

        if (
          (responseReceived && request.isNavigationRequest()) ||
          request.frame() !== page.mainFrame() ||
          !['document', ...(this.options.noScripts ? [] : ['script'])].includes(
            request.resourceType()
          )
        ) {
          request.abort('blockedbyclient')
        } else {
          const headers = {
            ...request.headers(),
            ...this.options.headers,
          }

          await this.emit('request', { page, request })

          request.continue({ headers })
        }
      } catch (error) {
        error.message += ` (${url})`

        this.error(error)
      }
    })

    // gets the response from page
    page.on('response', async (response) => {
      if (this.destroyed || !page || page.__closed || page.isClosed()) {
        return
      }

      try {
        if (
          response.status() < 300 &&
          response.frame().url() === url.href &&
          response.request().resourceType() === 'script'
        ) {
          const scripts = await response.text() // ajax response

          // analyzes the response
          await this.onDetect(response.url(), analyze({ scripts }))
        }
      } catch (error) {
        if (error.constructor.name !== 'ProtocolError') {
          error.message += ` (${url})`

          this.error(error)
        }
      }

      try {
        if (response.url() === url.href) {
          this.analyzedUrls[url.href] = {
            status: response.status(),
          }

          const rawHeaders = response.headers()
          const headers = {}

          Object.keys(rawHeaders).forEach((key) => {
            headers[key] = [
              ...(headers[key] || []),
              ...(Array.isArray(rawHeaders[key])
                ? rawHeaders[key]
                : [rawHeaders[key]]),
            ]
          })

          // Prevent cross-domain redirects
          if (response.status() >= 300 && response.status() < 400) {
            if (headers.location) {
              const _url = new URL(headers.location.slice(-1), url)

              if (
                _url.hostname.replace(/^www\./, '') ===
                  this.originalUrl.hostname.replace(/^www\./, '') ||
                (Object.keys(this.analyzedUrls).length === 1 &&
                  !this.options.noRedirect)
              ) {
                url = _url

                return
              }
            }
          }

          responseReceived = true

          const certIssuer = response.securityDetails()
            ? response.securityDetails().issuer()
            : ''

          // eslint-disable-next-line no-console
          console.log('page', page.response())
          // eslint-disable-next-line no-console
          console.log(
            'responseHeader',
            response.getResponseHeader('Content-Length')
          )
          // eslint-disable-next-line no-console
          console.log('header', headers)
          // eslint-disable-next-line no-console
          console.log('status', response.status())
          // eslint-disable-next-line no-console
          console.log('text', response.text())
          // eslint-disable-next-line no-console
          console.log('body', JSON.stringify(response.body()))

          await this.onDetect(url, analyze({ headers, certIssuer }))

          await this.emit('response', { page, response, headers, certIssuer })
        }
      } catch (error) {
        error.message += ` (${url})`

        this.error(error)
      }
    })

    // page content size
    await page.on('response', (response) => {
      const url = response.url()
      if (!url.startsWith('data:') && response.ok) {
        response.buffer().then(
          (b) => {
            const size = Number(b.length) / (1024 * 1024)
            this.totalSize += size
            // eslint-disable-next-line no-console
            console.log(`${response.status()} ${url} ${b.length} bytes`)
          },
          (e) => {
            // eslint-disable-next-line no-console
            console.error(`${response.status()} ${url} failed: ${e}`)
          }
        )
        // eslint-disable-next-line no-console
        console.log('totalSize:', this.totalSize)
      }
    })

    try {
      await page.goto(url.href)

      if (page.url() === 'about:blank') {
        const error = new Error(`The page failed to load (${url.href})`)

        error.code = 'WAPPALYZER_PAGE_EMPTY'

        throw error
      }

      if (!this.options.noScripts) {
        await sleep(1000)
      }

      // page.on('console', (message) => this.log(message.text()))

      // Cookies
      let cookies = []

      try {
        cookies = (await page.cookies()).reduce(
          (cookies, { name, value }) => ({
            ...cookies,
            [name.toLowerCase()]: [value],
          }),
          {}
        )
      } catch (error) {
        error.message += ` (${url})`

        this.error(error)
      }

      // HTML
      let html = await this.promiseTimeout(page.content(), '', 'Timeout (html)')

      if (this.options.htmlMaxCols && this.options.htmlMaxRows) {
        const batches = []
        const rows = html.length / this.options.htmlMaxCols

        for (let i = 0; i < rows; i += 1) {
          if (
            i < this.options.htmlMaxRows / 2 ||
            i > rows - this.options.htmlMaxRows / 2
          ) {
            batches.push(
              html.slice(
                i * this.options.htmlMaxCols,
                (i + 1) * this.options.htmlMaxCols
              )
            )
          }
        }

        html = batches.join('\n')
      }

      let links = []
      let text = ''
      let css = ''
      let scriptSrc = []
      let scripts = []
      let meta = []
      let js = []
      let dom = []
      // login
      let logins = {}
      // subscribe
      let subscribe = {}
      let livechats = {}

      if (html) {
        // Links
        links = !this.options.recursive
          ? []
          : await this.promiseTimeout(
              (
                await this.promiseTimeout(
                  page.evaluateHandle(() =>
                    Array.from(document.getElementsByTagName('a')).map(
                      ({ hash, hostname, href, pathname, protocol, rel }) => ({
                        hash,
                        hostname,
                        href,
                        pathname,
                        protocol,
                        rel,
                      })
                    )
                  ),
                  { jsonValue: () => [] },
                  'Timeout (links)'
                )
              ).jsonValue(),
              [],
              'Timeout (links)'
            )

        // login button
        logins = this.options.recursive
          ? {}
          : await this.promiseTimeout(
              (
                await this.promiseTimeout(
                  // delay page inspection by 20s
                  new Promise((resolve) => {
                    setTimeout(
                      () =>
                        resolve(
                          page.evaluateHandle(() => {
                            const signInRegExp =
                              /((sign|log)(\s{0,}|_)(in|up))|register/gi

                            // anchors
                            const anchors = Array.from(
                              document.getElementsByTagName('a')
                            )
                              .map(({ href, title, textContent, alt }) => ({
                                href,
                                title,
                                textContent,
                                alt,
                              }))
                              .filter(({ href, title, textContent, alt }) => {
                                const hrefIncludes =
                                  href && href.match(signInRegExp)
                                const titleIncludes =
                                  title && title.match(signInRegExp)
                                const textIncludes =
                                  textContent && textContent.match(signInRegExp)
                                const altIncludes =
                                  alt && alt.match(signInRegExp)
                                return (
                                  hrefIncludes ||
                                  titleIncludes ||
                                  textIncludes ||
                                  altIncludes
                                )
                              })

                            // check for a button with href attribute or textcontent that contains regex
                            const buttons = Array.from(
                              document.getElementsByTagName('button')
                            )
                              .map(({ href, title, textContent }) => ({
                                href,
                                title,
                                textContent,
                              }))
                              .filter(({ href, title, textContent }) => {
                                const hrefIncludes =
                                  href && href.match(signInRegExp)
                                const titleIncludes =
                                  title && title.match(signInRegExp)
                                const textIncludes =
                                  textContent && textContent.match(signInRegExp)
                                return (
                                  hrefIncludes || textIncludes || titleIncludes
                                )
                              })

                            // check for a div with a textcontent that contains regex
                            // const divTexts = Array.from(
                            //   document.getElementsByTagName('div')
                            // )
                            //   .map(({ textContent }) => ({
                            //     textContent,
                            //   }))
                            //   .filter(({ textContent }) => {
                            //     const textIncludes =
                            //       textContent && textContent.match(signInRegExp)
                            //     return textIncludes
                            //   })
                            //   .map(({ innerText }) => ({ innerText }))

                            // eslint-disable-next-line no-console
                            console.log(JSON.stringify(anchors))
                            return {
                              anchors,
                              buttons,
                              // divTexts
                            }
                          })
                        ),
                      20000
                    )
                  }),
                  { jsonValue: () => ({}) },
                  'Timeout (login)'
                )
              ).jsonValue(),
              {},
              'Timeout (login)'
            )

        // subscribe dialog
        subscribe = this.options.recursive
          ? {}
          : await this.promiseTimeout(
              (
                await this.promiseTimeout(
                  // delay page inspection by 20s
                  new Promise((resolve) => {
                    setTimeout(
                      () =>
                        resolve(
                          page.evaluateHandle(() => {
                            const emailInputRegex =
                              /(join|subscri(b|p)(e|tion)|sign(\s{0,}|_)up|newsletter|email)/gi
                            const emailPlaceholderRegex =
                              /(email|(^.{0,}@.{0,}\.com))/gi
                            const emailClassRegex =
                              /join|subsci(b|p)(e|tion)|sign(\s{0,1}|_)up|newsletter/gi
                            // const btnTextRegex =
                            //   /subscri(b|p)(e|tion)|newsletter/gi

                            const els = []
                            //  input
                            const inputBtnEls = (() => {
                              const emailInputEls = Array.from(
                                document.querySelectorAll('input[type=email]')
                              )
                                .filter(
                                  ({
                                    name: _name,
                                    id,
                                    placeholder,
                                    className,
                                  }) => {
                                    const nameIncludes =
                                      _name && _name.match(emailInputRegex)
                                    const idIncludes =
                                      id && id.match(emailInputRegex)
                                    const placeholderIncludes =
                                      placeholder &&
                                      placeholder.match(emailPlaceholderRegex)
                                    const classIncludes =
                                      className &&
                                      className
                                        .split(' ')
                                        .some((c) => c.match(emailClassRegex))
                                    return (
                                      nameIncludes ||
                                      idIncludes ||
                                      placeholderIncludes ||
                                      classIncludes
                                    )
                                  }
                                )
                                .map(
                                  ({ name, id, placeholder, className }) => ({
                                    name,
                                    id,
                                    placeholder,
                                    className,
                                  })
                                )

                              const btnEls = Array.from(
                                document.querySelectorAll('button')
                              )
                                .filter(
                                  ({ type, id, className, textContent }) => {
                                    // let typeMatches =
                                    //   type && type.match(/submit|button/gi)
                                    const idIncludes =
                                      id && id.match(emailClassRegex)
                                    const classIncludes =
                                      className &&
                                      className
                                        .split(' ')
                                        .some((c) => c.match(emailClassRegex))
                                    const textIncludes =
                                      textContent &&
                                      textContent.match(emailClassRegex)
                                    return (
                                      idIncludes ||
                                      classIncludes ||
                                      textIncludes
                                    )
                                  }
                                )
                                .map(
                                  ({ type, id, className, textContent }) => ({
                                    type,
                                    id,
                                    className,
                                    textContent,
                                  })
                                )

                              const submitInputEls = Array.from(
                                document.querySelectorAll(
                                  'input[type = submit]'
                                )
                              )
                                .filter(
                                  ({ type, id, className, name, value }) => {
                                    const typeMatches =
                                      type && type.match(/(submit)|(button)/gi)
                                    const idIncludes =
                                      id && id.match(emailClassRegex)
                                    const classIncludes =
                                      className &&
                                      className.match(emailClassRegex)
                                    const nameIncludes =
                                      name && name.match(emailClassRegex)
                                    const valueIncludes =
                                      value && value.match(emailClassRegex)
                                    return (
                                      typeMatches &&
                                      (idIncludes ||
                                        classIncludes ||
                                        nameIncludes ||
                                        valueIncludes)
                                    )
                                  }
                                )
                                .map(
                                  ({ type, id, className, name, value }) => ({
                                    type,
                                    id,
                                    className,
                                    name,
                                    value,
                                  })
                                )

                              els.push({
                                subscribe: {
                                  emailInputs: emailInputEls,
                                  btns: btnEls,
                                  submitInputs: submitInputEls,
                                },
                              })

                              return els
                            })()

                            return { inputBtnEls }
                          })
                        ),
                      20000
                    )
                  }),
                  { jsonValue: () => ({}) },
                  'Timeout (subscribe)'
                )
              ).jsonValue(),
              {},
              'Timeout (subscribe)'
            )

        // livechats
        livechats = this.options.recursive
          ? {}
          : await this.promiseTimeout(
              (
                await this.promiseTimeout(
                  // delay page inspection by 20s
                  new Promise((resolve) => {
                    setTimeout(
                      () =>
                        resolve(
                          page.evaluateHandle(() => {
                            const liveChatRegex =
                              /chat|widget|messag(e|ing)|twiliio|tawk|zapier|live(-|_|\s{0,})chat|mobile(-|_|\s{0,})monkey|go(-|_|\s{0,})bot|purechat|bold(-|_|\s{0,})360|wp(-|_|\s{0,})chat|tidio|smarts(-|_|\s{0,})upp|chatty(-|_|\s{0,})people|user(-|_|\s{0,})like|chatra|chaport|snapengage|acquire|kayako|fresh(-|_|\s{0,})chat|drift|help(-|_|\s{0,})crunch|zendesk(-|_|\s{0,})chat|click(-|_|\s{0,})desk|inter(-|_|\s{0,})com|olark|g2|fresh(-|_|\s{0,})desk|crisp|live(-|_|\s{0,})zilla|jivo(-|_|\s{0,})chat|qualaroo|hotjar|flash(-|_|\s{0,})talking/gi
                            // iframes
                            const iframes = Array.from(
                              document.getElementsByTagName('iframe')
                            )
                              .filter(({ id, title, src }) => {
                                const idIncludes = id && id.match(liveChatRegex)
                                const titleIncludes =
                                  title && title.match(liveChatRegex)
                                const srcIncludes =
                                  src && title.match(liveChatRegex)
                                return (
                                  idIncludes || titleIncludes || srcIncludes
                                )
                              })
                              .map(({ id, title, src }) => ({ id, title, src }))

                            const scripts = Array.from(
                              document.getElementsByTagName('script')
                            )
                              .filter(({ src }) => {
                                const srcIncludes =
                                  src && src.match(liveChatRegex)
                                return srcIncludes
                              })
                              .map(({ src }) => ({ src }))

                            return { iframes, scripts }
                          })
                        ),
                      20000
                    )
                  }),
                  { jsonValue: () => ({}) },
                  'Timeout (livechats)'
                )
              ).jsonValue(),
              {},
              'Timeout (livechats)'
            )

        // Text
        text = await this.promiseTimeout(
          (
            await this.promiseTimeout(
              page.evaluateHandle(
                () =>
                  // eslint-disable-next-line unicorn/prefer-text-content
                  document.body && document.body.innerText
              ),
              { jsonValue: () => '' },
              'Timeout (text)'
            )
          ).jsonValue(),
          '',
          'Timeout (text)'
        )

        // CSS
        css = await this.promiseTimeout(
          (
            await this.promiseTimeout(
              page.evaluateHandle((maxRows) => {
                const css = []

                try {
                  if (!document.styleSheets.length) {
                    return ''
                  }

                  for (const sheet of Array.from(document.styleSheets)) {
                    for (const rules of Array.from(sheet.cssRules)) {
                      css.push(rules.cssText)

                      if (css.length >= maxRows) {
                        break
                      }
                    }
                  }
                } catch (error) {
                  return ''
                }

                return css.join('\n')
              }, this.options.htmlMaxRows),
              { jsonValue: () => '' },
              'Timeout (css)'
            )
          ).jsonValue(),
          '',
          'Timeout (css)'
        )

        // Script tags
        ;[scriptSrc, scripts] = await this.promiseTimeout(
          (
            await this.promiseTimeout(
              page.evaluateHandle(() => {
                const nodes = Array.from(
                  document.getElementsByTagName('script')
                )

                return [
                  nodes
                    .filter(
                      ({ src }) =>
                        src && !src.startsWith('data:text/javascript;')
                    )
                    .map(({ src }) => src),
                  nodes
                    .map((node) => node.textContent)
                    .filter((script) => script),
                ]
              }),
              { jsonValue: () => [] },
              'Timeout (scripts)'
            )
          ).jsonValue(),
          [],
          'Timeout (scripts)'
        )

        // Meta tags
        meta = await this.promiseTimeout(
          (
            await this.promiseTimeout(
              page.evaluateHandle(() =>
                Array.from(document.querySelectorAll('meta')).reduce(
                  (metas, meta) => {
                    const key =
                      meta.getAttribute('name') || meta.getAttribute('property')

                    if (key) {
                      metas[key.toLowerCase()] = metas[key.toLowerCase()] || []

                      metas[key.toLowerCase()].push(
                        meta.getAttribute('content')
                      )
                    }

                    return metas
                  },
                  {}
                )
              ),
              { jsonValue: () => [] },
              'Timeout (meta)'
            )
          ).jsonValue(),
          [],
          'Timeout (meta)'
        )

        // JavaScript
        js = this.options.noScripts
          ? []
          : await this.promiseTimeout(getJs(page), [], 'Timeout (js)')

        // DOM
        dom = await this.promiseTimeout(getDom(page), [], 'Timeout (dom)')
      }

      this.cache[url.href] = {
        page,
        html,
        text,
        cookies,
        scripts,
        scriptSrc,
        meta,
      }

      this.inspects = {
        login: logins,
        subscribe,
        livechats,
      }

      await this.onDetect(
        url,
        [
          analyzeDom(dom),
          analyzeJs(js),
          analyze({
            url,
            cookies,
            html,
            text,
            css,
            scripts,
            scriptSrc,
            meta,
          }),
        ].flat()
      )

      const reducedLinks = Array.prototype.reduce.call(
        links,
        (results, link) => {
          if (
            results &&
            Object.prototype.hasOwnProperty.call(
              Object.getPrototypeOf(results),
              'push'
            ) &&
            link.protocol &&
            link.protocol.match(/https?:/) &&
            link.hostname === url.hostname &&
            extensions.test(link.pathname.slice(-5))
          ) {
            results.push(new URL(link.href.split('#')[0]))
          }

          return results
        },
        []
      )

      await this.emit('goto', {
        page,
        url,
        links: reducedLinks,
        ...this.cache[url.href],
      })
      page.__closed = true

      try {
        await page.close()

        this.log(`Page closed (${url})`)
      } catch (error) {
        // Continue
      }

      this.log(`Page closed (${url})`)

      return reducedLinks
    } catch (error) {
      page.__closed = true
      try {
        await page.close()

        this.log(`Page closed (${url})`)
      } catch (error) {
        // Continue
      }
      if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
        const newError = new Error(`Hostname could not be resolved (${url})`)

        newError.code = 'WAPPALYZER_DNS_ERROR'

        throw newError
      }

      if (
        error.constructor.name === 'TimeoutError' ||
        error.code === 'PROMISE_TIMEOUT_ERROR'
      ) {
        error.code = 'WAPPALYZER_TIMEOUT_ERROR'
      }

      error.message += ` (${url})`

      throw error
    }
  }

  // analyzes the url passed in
  async analyze(url = this.originalUrl, index = 1, depth = 1) {
    // eslint-disable-next-line no-console
    console.log('url', url)

    if (this.options.recursive) {
      await sleep(this.options.delay * index)
    }

    await Promise.allSettled([
      (async () => {
        try {
          const links = ((await this.goto(url)) || []).filter(
            ({ href }) => !this.analyzedUrls[href]
          )

          if (
            links.length &&
            this.options.recursive &&
            Object.keys(this.analyzedUrls).length < this.options.maxUrls &&
            depth < this.options.maxDepth
          ) {
            await this.batch(
              links.slice(
                0,
                this.options.maxUrls - Object.keys(this.analyzedUrls).length
              ),
              depth + 1
            )
          }
        } catch (error) {
          this.analyzedUrls[url.href] = {
            status: this.analyzedUrls[url.href]?.status || 0,
            error: error.message || error.toString(),
          }

          error.message += ` (${url})`

          this.error(error)
        }
      })(),
      (async () => {
        if (this.options.probe && !this.probed) {
          this.probed = true

          await this.probe(url)
        }
      })(),
    ])

    const patterns = this.options.extended
      ? this.detections.reduce(
          (
            patterns,
            {
              technology: { name, implies, excludes },
              pattern: { regex, value, match, confidence, type, version },
            }
          ) => {
            patterns[name] = patterns[name] || []

            patterns[name].push({
              type,
              regex: regex.source,
              value: value.length <= 250 ? value : null,
              match: match.length <= 250 ? match : null,
              confidence,
              version,
              implies: implies.map(({ name }) => name),
              excludes: excludes.map(({ name }) => name),
            })

            return patterns
          },
          {}
        )
      : undefined

    const results = {
      urls: this.analyzedUrls,
      size: `${this.totalSize} MB`,
      technologies: resolve(this.detections).map(
        ({
          slug,
          name,
          confidence,
          version,
          icon,
          website,
          cpe,
          categories,
          description,
        }) => ({
          slug,
          name,
          confidence,
          version: version || null,
          icon,
          website,
          cpe,
          categories: categories.map(({ id, slug, name }) => ({
            id,
            slug,
            name,
          })),
          description: description || '',
        })
      ),
      patterns,
      inspects: this.inspects,
    }

    await this.emit('analyze', results)

    return results
  }

  async probe(url) {
    const files = {
      robots: '/robots.txt',
      magento: '/magento_version',
    }

    // DNS
    const records = {}
    const resolveDns = (func, hostname) => {
      return this.promiseTimeout(
        func(hostname).catch((error) => {
          if (error.code !== 'ENODATA') {
            error.message += ` (${url})`

            this.error(error)
          }

          return []
        }),
        [],
        'Timeout (dns)',
        Math.min(this.options.maxWait, 15000)
      )
    }

    const domain = url.hostname.replace(/^www\./, '')

    await Promise.allSettled([
      // Static files
      ...Object.keys(files).map(async (file, index) => {
        const path = files[file]

        try {
          await sleep(this.options.delay * index)

          const body = await get(new URL(path, url.href), {
            userAgent: this.options.userAgent,
            timeout: Math.min(this.options.maxWait, 1000),
          })

          this.log(`Probe ok (${path})`)

          await this.onDetect(url, analyze({ [file]: body.slice(0, 100000) }))
        } catch (error) {
          this.error(`Probe failed (${path}): ${error.message || error}`)
        }
      }),
      // DNS
      // eslint-disable-next-line no-async-promise-executor
      new Promise(async (resolve, reject) => {
        ;[records.cname, records.ns, records.mx, records.txt, records.soa] =
          await Promise.all([
            resolveDns(dns.resolveCname, url.hostname),
            resolveDns(dns.resolveNs, domain),
            resolveDns(dns.resolveMx, domain),
            resolveDns(dns.resolveTxt, domain),
            resolveDns(dns.resolveSoa, domain),
          ])

        const dnsRecords = Object.keys(records).reduce((dns, type) => {
          dns[type] = dns[type] || []

          Array.prototype.push.apply(
            dns[type],
            Array.isArray(records[type])
              ? records[type].map((value) => {
                  return typeof value === 'object'
                    ? Object.values(value).join(' ')
                    : value
                })
              : [Object.values(records[type]).join(' ')]
          )

          return dns
        }, {})

        this.log(
          `Probe DNS ok: (${Object.values(dnsRecords).flat().length} records)`
        )

        await this.onDetect(url, analyze({ dns: dnsRecords }))

        resolve()
      }),
    ])
  }

  async batch(links, depth, batch = 0) {
    if (links.length === 0) {
      return
    }

    const batched = links.splice(0, this.options.batchSize)

    await Promise.allSettled(
      batched.map((link, index) => this.analyze(link, index, depth))
    )

    await this.batch(links, depth, batch + 1)
  }

  // on detecting technologies
  async onDetect(url, detections = []) {
    this.detections = this.detections
      .concat(detections)
      .filter(
        ({ technology: { name }, pattern: { regex } }, index, detections) =>
          detections.findIndex(
            ({ technology: { name: _name }, pattern: { regex: _regex } }) =>
              name === _name &&
              (!regex || regex.toString() === _regex.toString())
          ) === index
      )

    if (this.cache[url.href]) {
      const resolved = resolve(this.detections)

      const requires = [
        ...Wappalyzer.requires.filter(({ name }) =>
          resolved.some(({ name: _name }) => _name === name)
        ),
        ...Wappalyzer.categoryRequires.filter(({ categoryId }) =>
          resolved.some(({ categories }) =>
            categories.some(({ id }) => id === categoryId)
          )
        ),
      ]

      await Promise.allSettled(
        requires.map(async ({ name, categoryId, technologies }) => {
          const id = categoryId
            ? `category:${categoryId}`
            : `technology:${name}`

          this.analyzedRequires[url.href] =
            this.analyzedRequires[url.href] || []

          if (!this.analyzedRequires[url.href].includes(id)) {
            this.analyzedRequires[url.href].push(id)

            const { page, cookies, html, text, css, scripts, scriptSrc, meta } =
              this.cache[url.href]

            const js = await this.promiseTimeout(
              getJs(page, technologies),
              [],
              'Timeout (js)'
            )
            const dom = await this.promiseTimeout(
              getDom(page, technologies),
              [],
              'Timeout (dom)'
            )

            await this.onDetect(
              url,
              [
                analyzeDom(dom, technologies),
                analyzeJs(js, technologies),
                await analyze(
                  {
                    url,
                    cookies,
                    html,
                    text,
                    css,
                    scripts,
                    scriptSrc,
                    meta,
                  },
                  technologies
                ),
              ].flat()
            )
          }
        })
      )
    }
  }

  async destroy() {
    await Promise.allSettled(
      this.pages.map(async (page) => {
        if (page) {
          page.__closed = true

          try {
            await page.close()
          } catch (error) {
            // Continue
          }
        }
      })
    )

    this.destroyed = true

    this.log('Site closed')
  }
}

module.exports = Driver
