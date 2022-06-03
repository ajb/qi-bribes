const chalk = require('chalk')
const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const PROPOSAL_ID = '0xae009d3fc6517df8d2761a891be63a8a459e68e54d0b8043de176070a23ac51c'
const PAGE_SIZE = 1000
const OUR_BRIBED_CHOICE = 'WBTC (Arbitrum)'
const QI_BRIBE_PER_ONE_PERCENT = BigNumber(1000)
const WHALE_THRESHOLD = 250000
const WHALE_REDISTRIBUTION = 20

async function main () {
  const proposalQuery = gql`
  query {
    proposals (
      where: {
        id: "${PROPOSAL_ID}"
      }
    ) {
      id
      title
      body
      choices
      start
      end
      snapshot
      state
      scores
      scores_by_strategy
      scores_total
      scores_updated
      author
      space {
        id
        name
      }
    }
    }
`

  const resp = await request(GRAPHQL_ENDPOINT, proposalQuery)
  const choicesDict = ['', ...resp.proposals[0].choices] // starts at idx = 1

  const votes = []

  let i = 0
  while (true) {
    const query = gql`
    query {
      votes (
        first: ${PAGE_SIZE}
        skip: ${i * PAGE_SIZE}
        where: {
          proposal: "${PROPOSAL_ID}"
        }
        orderBy: "created",
        orderDirection: desc
      ) {
        id
        voter
        vp
        created
        choice
      }
    }
  `

    const resp = await request(GRAPHQL_ENDPOINT, query)
    votes.push(...resp.votes)

    if (resp.votes.length === PAGE_SIZE) {
      i++
    } else {
      break
    }
  }

  const totals = {}

  for (const vote of votes) {
    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (!totals[choiceId]) totals[choiceId] = BigNumber(0)
      totals[choiceId] = BigNumber.sum(totals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
    }
  }

  const totalVote = BigNumber.sum(...Object.values(totals))

  const totalsArr = []
  const percentagesByChain = {}
  let ourChoicePercentage
  let ourChoiceVotes

  for (const [choiceId, sumVotes] of Object.entries(totals)) {
    const percentage = sumVotes.div(totalVote).times(100)
    const chain = choicesDict[choiceId].split('(')[1].split(')')[0]

    totalsArr.push({
      choice: choicesDict[choiceId],
      votes: sumVotes.toFixed(0),
      percentage: percentage.toFixed(2) + ' %'
    })

    if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
      ourChoiceVotes = sumVotes
      ourChoicePercentage = percentage
    }

    if (!percentagesByChain[chain]) percentagesByChain[chain] = BigNumber(0)
    percentagesByChain[chain] = BigNumber.sum(percentagesByChain[chain], percentage)
  }

  totalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

  console.log('')
  console.log(chalk.blue.underline('Current vote totals'))
  console.log('')
  console.table(totalsArr)

  const percentagesByChainArr = []
  for (const [chain, p] of Object.entries(percentagesByChain)) {
    percentagesByChainArr.push([chain, p.toFixed(2)])
  }
  percentagesByChainArr.sort((a, b) => BigNumber(a[1]).gt(b[1]) ? -1 : 1)

  console.log('')
  console.log(chalk.blue.underline('Vote totals by chain'))
  console.log('')
  console.table(percentagesByChainArr)

  if (percentagesByChain.Arbitrum.lt('8.333')) {
    throw new Error('no bribes, Arbitrum did not cross threshold')
  }

  const totalBribe = BigNumber(ourChoicePercentage).times(QI_BRIBE_PER_ONE_PERCENT)
  const bribes = {}

  for (const vote of votes) {
    if (vote.vp === 0) continue

    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
        const choiceVote = BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight)
        const percentageOfChoiceVote = choiceVote.div(ourChoiceVotes).times(100)
        const bribe = BigNumber(totalBribe).times(percentageOfChoiceVote).div(100)
        bribes[vote.voter] = {
          voterVp: vote.vp,
          choicePerc: percentageOfChoiceVote.toFixed(),
          bribeAmount: bribe.toFixed(2)
        }
      }
    }
  }

  let clawedBackWhaleBribeAmount = BigNumber(0)

  for (const i in bribes) {
    if (BigNumber(bribes[i].voterVp).gt(WHALE_THRESHOLD)) {
      clawedBackWhaleBribeAmount = BigNumber.sum(clawedBackWhaleBribeAmount, bribes[i].bribeAmount)
      bribes[i].bribeAmount = 0
    }
  }

  for (const i in bribes) {
    if (BigNumber(bribes[i].voterVp).lt(WHALE_THRESHOLD)) {
      bribes[i].additionalWhaleBribe = BigNumber(bribes[i].choicePerc).times(clawedBackWhaleBribeAmount).times(WHALE_REDISTRIBUTION).div(100).div(100).toFixed(2)
    } else {
      bribes[i].additionalWhaleBribe = 0
    }

    bribes[i].totalBribe = BigNumber.sum(bribes[i].bribeAmount, bribes[i].additionalWhaleBribe).toFixed(2)

    const globalPerc = BigNumber(bribes[i].choicePerc).times(ourChoicePercentage).div(100)

    bribes[i].qiPerPercent = BigNumber(bribes[i].totalBribe).div(globalPerc).toFixed(2)
  }

  const sumBribes = BigNumber.sum(...Object.values(bribes).map(b => b.totalBribe))

  console.log('')
  console.log(chalk.blue.underline('Clawed back whale bribes'))
  console.log('')
  console.log(`${clawedBackWhaleBribeAmount.toFixed(2)} QI`)

  console.log('')
  console.log(chalk.blue.underline('Our bribes'))
  console.log('')
  console.log(`${sumBribes.toFixed(2)} QI`)

  console.log('')
  console.log(chalk.blue.underline('Bribes by voter'))
  console.log('')
  console.table(bribes)
}

main()
