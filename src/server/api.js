// const http = require('http')
// const path = require('path')
const express = require('express')
const { fetchUrls } = require('../drivers/npm/server')

const port = 8080

const server = express()

// const httpServer = http.createServer(server)

// const publicDirectoryPath = path.join(__dirname, '../client/index.html')

// on the request to root (localhost:8080/)
server.get('/', function (req, res) {
  res
    .status(200)
    .send(
      '<b>Wappalyzer</b>\nLook up a url by changing the url as so; <b>http://backend.myserver.com:8080/lookup?urls={type_in_url_here}&sets=all</b>'
    )
  // res.status(200).sendFile(path.join(__dirname, '../client/index.html'))
  res.end()
})

server.get('/test/json', function (req, res) {
  res.status(200).json({ res: "Hey, I'm sending a json" })
  res.end()
})

server.get('/lookup', async (req, res) => {
  const { urls } = req.query

  // eslint-disable-next-line no-console
  console.log(urls)

  const results = await fetchUrls(urls)
  res.status(200).send(results)
  res.end()
})

// server.use(express.static(path.resolve(__dirname, '/src')))

server.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  )
  next()
  res.status(404).send("Sorry, that route doesn't exist. Have a nice day :)")
  res.end()
})

// process.env.NODE_ENV === 'production'
//   ?
server.listen(process.env.PORT || port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server is running on port ${process.env.PORT || port}`)
})
// :
// server.listen(port, 'backend.myserver.com', 511, () => {
//   // eslint-disable-next-line no-console
//   console.log(`Server listening on port ${port}`)
// })
