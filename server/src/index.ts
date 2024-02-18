import { serve } from '@hono/node-server'
import { createClient } from '@supabase/supabase-js'
import { Hono } from 'hono'
import { PDFLoader } from 'langchain/document_loaders/fs/pdf'
import { OpenAI, OpenAIEmbeddings } from '@langchain/openai'
import openaI from 'openai'
import { config } from 'dotenv'
import { ChatPromptTemplate } from 'langchain/prompts'
import { createStuffDocumentsChain } from 'langchain/chains/combine_documents'
import { pull } from 'langchain/hub'
import { StringOutputParser } from 'langchain/schema/output_parser'
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase'
import { PuppeteerWebBaseLoader } from 'langchain/document_loaders/web/puppeteer'
import * as cheerio from 'cheerio'
import path from 'path'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { HtmlToTextTransformer } from 'langchain/document_transformers/html_to_text'
import { CheerioWebBaseLoader } from 'langchain/document_loaders/web/cheerio'
import axios from 'axios'
import { cors } from 'hono/cors'
import { Document } from 'langchain/document'
config()
const app = new Hono()
app.use(
  '/*',
  cors({
    origin: 'http://localhost:3001',
    allowHeaders: ['Access-Control-Allow-Origin', 'http://localhost:3000'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
    maxAge: 600,
    credentials: true,
  }),
)
const privateKey = process.env.SUPABASE_PRIVATE_KEY
if (!privateKey) throw new Error(`Expected env var SUPABASE_PRIVATE_KEY`)

const url = process.env.SUPABASE_URL
if (!url) throw new Error(`Expected env var SUPABASE_URL`)
const client = createClient(url, privateKey)
const vectorStore = new SupabaseVectorStore(new OpenAIEmbeddings(), {
  client,
  tableName: 'documents',
})
app.get('/', (c) => {
  getBusDetails('sylhet', 'dhaka', '2024-02-18')
  return c.text('Hello Hono!')
})

const model = new OpenAI({
  modelName: 'gpt-4-0125-preview',
  temperature: 0.1,
  openAIApiKey: process.env.OPENAI_API_KEY,
})

const similaritySearch = async (
  query: string,
  userId: string,
  sessionId: string,
) => {
  const result = await vectorStore.similaritySearch(query, 20, {
    user_id: userId,
    sessionId: sessionId,
  })
  // console.log(result)
  return result
}
const getAnswer = async (query: string, userId: string, sessionId: string) => {
  const retriever = vectorStore.asRetriever()
  const prompt = await pull<ChatPromptTemplate>('rlm/rag-prompt')
  const ragChain = await createStuffDocumentsChain({
    llm: model,
    prompt,
    outputParser: new StringOutputParser(),
  })
  // const retDocs = await retriever.getRelevantDocuments(query)
  const retDocs = await similaritySearch(query, userId, sessionId)
  console.log(retDocs)
  const res = await ragChain.invoke({ question: query, context: retDocs })
  return res
}

const embeddings = new OpenAIEmbeddings({
  openAIApiKey: process.env.OPENAI_API_KEY,
  batchSize: 512,
  modelName: 'text-embedding-3-large',
})
const getEmbedding = async (text: string) => {
  const res = await embeddings.embedQuery(text)
  return res
}

const createAQuiz = async (text: string) => {
  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant You will be given a text and you create a quiz based on the text and return the quiz',
      },
      {
        role: 'user',
        content: `create a quiz based on this text: ${text} and don't add any unnecessary text. and if there is no content, return an empty string.`,
      },
    ],
    model: 'gpt-4-0125-preview',
  })

  console.log(completion.choices[0])
  return completion.choices[0].message.content
}

app.post('/createQuiz', async (c) => {
  const body = await c.req.parseBody()
  const text: any = body['text']
  const res = await createAQuiz(text)
  console.log(text)
  return c.json({
    ok: true,
    message: res,
  })
})

const addToVector = async (user_id: number, docs: any) => {
  await vectorStore.addDocuments(docs)
  console.log(docs)
}
const openai = new openaI()
async function tts(text: string) {
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
  })
  console.log(mp3)
  const speechFile = path.resolve('./speech.mp3')
  console.log(speechFile)
  const buffer = Buffer.from(await mp3.arrayBuffer())
  return buffer.toString('base64')
  // await fs.promises.writeFile(speechFile, buffer)
}

async function clearPageContent(docs: any) {
  for (let i = 0; i < docs.length; i++) {
    docs[i].pageContent = cleanDocs(docs[i].pageContent)
  }
  return docs
}

async function getImageDetails(imageUrl: string) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-vision-preview',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ],
  })
  console.log(response.choices[0])
  return response.choices[0]
}

async function crawlPage(url: string) {
  const loader = new PuppeteerWebBaseLoader(url)

  const docs = await loader.load()
  console.log(docs)

  const splitter = RecursiveCharacterTextSplitter.fromLanguage('html')
  const transformer = new HtmlToTextTransformer()

  const sequence = splitter.pipe(transformer)

  let newDocuments = await sequence.invoke(docs)
  return newDocuments
}

async function cleanDocs(content: string) {
  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant You will be given a html content and you clean it meaning remove new line character, unnecessary space, extra part of code that is not needed. and return main content. you do not need to access any other website',
      },
      {
        role: 'user',
        content:
          '<html><head><title>Page Title</title></head><body><h1>This is a Heading</h1><p>This is a paragraph.</p></body></html>',
      },
      { role: 'assistant', content: 'This is a paragraph.' },
      { role: 'user', content: "className: 'content'" },
      { role: 'assistant', content: '' },
      {
        role: 'user',
        content: `remove unnecessary css and return the cleaner version of this content: ${content} and don't add any unnecessary text. and if there is no content, return an empty string.`,
      },
    ],
    model: 'gpt-4-0125-preview',
  })

  console.log(completion.choices[0])
  return completion.choices[0].message.content
}

const getShortDescription = async (word: string) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-0125-preview',
    messages: [
      {
        role: 'user',
        content: `Explain this word ${word} as easy as possible and as short as possible, don't add unncessary text only the response.`,
      },
    ],
  })
  // console.log(response.choices[0])
  return response.choices[0].message.content
}

const getDarazResults = async (query: string) => {
  const { data } = await axios.get('https://www.daraz.com.bd/catalog/?q=book')
  // console.log(data)
  const $ = cheerio.load(data)
  const $selected = $('.ant-col-19')
  console.log($selected)
}

app.post('/uploadPdf', async (c) => {
  const body = await c.req.parseBody()
  const userId: any = body['userId']
  const fileName = body['fileName']
  const file = body['file']
  const sessionId: any = body['sessionId']

  if (!(file instanceof File)) {
    throw new Error('Invalid file type')
  }

  const loader = new PDFLoader(file, {
    parsedItemSeparator: '  ',
  })

  const docs = await loader.load()
  for (let i = 0; i < docs.length; i++) {
    docs[i].metadata['user_id'] = userId
    docs[i].metadata['fileName'] = fileName
    docs[i].metadata['sessionId'] = sessionId
  }
  // console.log((await getEmbedding('HI')).length)
  const batchSize = 100
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize)
    await addToVector(1, batch)
  }

  return c.json({
    ok: true,
    message: 'File uploaded successfully',
  })
})

app.post('/uploadImage', async (c) => {
  const body = await c.req.parseBody()
  const userId: any = body['userId']
  const fileName = body['fileName']
  const image = body['image']
  const sessionId: any = body['sessionId']
  let text = ''
  if (typeof image === 'string') {
    const imageDetails = await getImageDetails(image)
    if (imageDetails.message.content !== null) {
      text = imageDetails.message.content
    }
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 1,
  })

  let docs = await splitter.splitDocuments([
    new Document({ pageContent: text }),
  ])
  console.log(docs)
  for (let i = 0; i < docs.length; i++) {
    docs[i].metadata['user_id'] = userId
    docs[i].metadata['fileName'] = fileName
    docs[i].metadata['sessionId'] = sessionId
  }

  // console.log((await getEmbedding('HI')).length)
  const batchSize = 100
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize)
    await addToVector(1, batch)
  }

  return c.json({
    ok: true,
    message: text,
  })
})

import { YoutubeLoader } from 'langchain/document_loaders/web/youtube'
app.post('/uploadYoutube', async (c) => {
  const body = await c.req.parseBody()
  const userId: any = body['userId']
  const fileName = body['fileName']
  const youtube = body['youtube']
  const sessionId: any = body['sessionId']
  if (typeof youtube !== 'string') {
    throw new Error('Youtube URL must be a string')
  }

  const loader = YoutubeLoader.createFromUrl(youtube, {
    language: 'en',
    addVideoInfo: true,
  })

  let docs = await loader.load()
  console.log(docs)
  for (let i = 0; i < docs.length; i++) {
    docs[i].metadata['user_id'] = userId
    docs[i].metadata['fileName'] = fileName
    docs[i].metadata['sessionId'] = sessionId
  }

  // console.log((await getEmbedding('HI')).length)
  const batchSize = 100
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize)
    await addToVector(1, batch)
  }

  return c.json({
    ok: true,
    message: 'Youtube video added successfully',
  })
})

app.post('/uploadWebsite', async (c) => {
  const body = await c.req.parseBody()
  const userId: any = body['userId']
  const sessionId: any = body['sessionId']
  const fileName = body['fileName']
  const web = body['web']

  if (typeof web !== 'string') {
    throw new Error('Youtube URL must be a string')
  }

  let docs = await crawlPage(web)

  for (let i = 0; i < docs.length; i++) {
    docs[i].metadata['user_id'] = userId
    docs[i].metadata['fileName'] = fileName
    docs[i].metadata['sessionId'] = sessionId
  }
  console.log(docs)

  // console.log((await getEmbedding('HI')).length)
  const batchSize = 10
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize)
    for (let doc of batch) {
      if (doc['pageContent'] !== undefined) await addToVector(1, [doc])
    }
  }

  return c.json({
    ok: true,
    message: 'website added successfully',
  })
})

app.post('/getAnswer', async (c) => {
  const body = await c.req.parseBody()
  const userId: any = body['userId']
  const query = body['query']
  const sessionId: any = body['sessionId']
  const chatHistory: any = body['chatHistory']

  if (typeof query !== 'string') {
    throw new Error('Query must be a string')
  }

  const res = await getAnswer(query, userId, sessionId, chatHistory)
  console.log(res)
  return c.json({
    ok: true,
    message: res,
  })
})

app.post('/getAudio', async (c) => {
  const body = await c.req.parseBody()
  const text: any = body['text']
  const res = await tts(text)
  return c.json({
    ok: true,
    message: res,
  })
})
interface TrainDetails {
  trainName: string
  seatType: string
  seatsLeft: number
}

const getBusDetails = async (to: string, from: string, date: string) => {
  const axios = require('axios')
  let data = JSON.stringify({
    date: date,
    identifier: from + '-' + 'to' + '-' + to,
    structureType: 'BUS',
  })

  let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://api.bdtickets.com:20102/v1/coaches/search',
    headers: {
      authority: 'api.bdtickets.com:20102',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-BD,en-US;q=0.9,en;q=0.8,bn;q=0.7',
      'content-type': 'application/json',
      dnt: '1',
      origin: 'https://www.bdtickets.com',
      referer: 'https://www.bdtickets.com/',
      'sec-ch-ua':
        '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'sec-gpc': '1',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    },
    data: data,
  }

  axios
    .request(config)
    .then(async (response: any) => {
      console.log(JSON.stringify(response.data))
      return JSON.stringify(response.data)
    })
    .catch((error: any) => {
      console.log(error)
    })
}

const cleanBusData = async (data: any) => {
  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant You will be given a json content of bus details and you clean it and return a list with bus name,DEPARTURE TIME,ARRIVAL TIME,SEATS AVAILABLE and price',
      },
      {
        role: 'user',
        content: `clean this json and : ${data},
        )} and then return a list with bus name,DEPARTURE TIME,ARRIVAL TIME,SEATS AVAILABLE and price  and don't add any unnecessary text. and if there is no content, return an empty string.`,
      },
    ],
    model: 'gpt-4-0125-preview',
  })

  console.log(completion.choices[0])
  return completion.choices[0].message.content
}

import { DynamicTool } from '@langchain/core/tools'

const custom_tool = new DynamicTool({
  name: 'getBusDetailsInJson',
  description:
    'given which city to start and which city to go and which date, return the bus details, like bus name,DEPARTURE TIME,ARRIVAL TIME,SEATS AVAILABLE and price, the city name must be in lowercase date should be in the format of yyyy-mm-dd the input form is like this to.from.date this function will return a messy json data which needs to be cleaned',
  func: async (input: string) => {
    const [to, from, date] = input.split('.')
    const ret = await getBusDetails(to, from, date)
    return ret !== undefined ? ret : ''
  },
})
const custom_tool2 = new DynamicTool({
  name: 'cleanJsonData',
  description:
    'given any json data of bus details, clean it and return a list with bus name,DEPARTURE TIME,ARRIVAL TIME,SEATS AVAILABLE and price',
  func: async (input: string) => {
    const ret = await cleanBusData(input)
    if (ret === null) {
      throw new Error('Result was null')
    }
    return ret !== undefined ? ret : ''
  },
})

const tools = [custom_tool, custom_tool2]
import { AgentExecutor, createStructuredChatAgent } from 'langchain/agents'

app.post('/casual', async (c) => {
  const body = await c.req.parseBody()
  const ques: any = body['ques']
  const prompt = await pull<ChatPromptTemplate>(
    'hwchase17/structured-chat-agent',
  )
  const agent = await createStructuredChatAgent({
    llm: model,
    tools,
    prompt,
  })

  const agentExecutor = new AgentExecutor({
    agent,
    tools,
  })

  const result = await agentExecutor.invoke({
    input: ques,
  })
  return c.json({
    ok: true,
    message: result,
  })
})

app.post('/getDesc', async (c) => {
  const body = await c.req.parseBody()
  const text: any = body['text']
  const res = await getShortDescription(text)
  return c.json({
    ok: true,
    message: res,
  })
})

const port = 3000
console.log(`Server is running on port ${port}`)

serve({
  fetch: app.fetch,
  port,
})
