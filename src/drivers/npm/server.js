const Wappalyzer = require('./driver')

module.exports = {
  async fetchUrls(url) {
    const options = {}
    if (!url) {
      return JSON.stringify({
        data: 'no url passed',
      })
    }

    const wappalyzer = new Wappalyzer(options)

    try {
      await wappalyzer.init()

      const site = await wappalyzer.open(url)

      const results = await site.analyze()

      await wappalyzer.destroy()

      return JSON.stringify(results, null, options ? 2 : null)
    } catch (error) {
      // console.error(error)

      await wappalyzer.destroy()

      return JSON.stringify(error)
    }
  },
}
