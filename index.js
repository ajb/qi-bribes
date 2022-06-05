const chalk = require('chalk')
const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')
const tableify = require('tableify')
const cloneDeep = require('lodash.clonedeep')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const QIDAO_PROPOSAL_ID = '0xae009d3fc6517df8d2761a891be63a8a459e68e54d0b8043de176070a23ac51c'
const TETU_REFLECTION_PROPOSAL_ID = '0x9e9f062225de4fd04f1cf643a0334e00f2988310c71d55ba3a04c02a247e0464'
const PAGE_SIZE = 1000
const OUR_BRIBED_CHOICE = 'WBTC (Arbitrum)'
const QI_BRIBE_PER_ONE_PERCENT = BigNumber(1000)
const WHALE_THRESHOLD = 250000 // 250k eQI
const TETU_WHALE_THRESHOLD = 5000000 // 5m dxTETU
const WHALE_REDISTRIBUTION = 20
const BEEFY_VOTER_ADDRESS = '0x5e1caC103F943Cd84A1E92dAde4145664ebf692A'
const TETU_ADDRESS = '0x0644141DD9C2c34802d28D334217bD2034206Bf7'
const MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS = BigNumber('8.333')
const TOTAL_WEEKLY_QI = BigNumber(180000)
const TOTAL_QI_PER_BLOCK = BigNumber(0.65)

function shouldClawBackWhale (address, voterVp) {
  if (address === TETU_ADDRESS) return false
  if (address === BEEFY_VOTER_ADDRESS) return false
  return BigNumber(voterVp).gt(WHALE_THRESHOLD)
}

function shouldZeroBribe (address) {
  if (address === BEEFY_VOTER_ADDRESS) return true
  return false
}

function shouldClawBackTetuWhale (voterVp) {
  return BigNumber(voterVp).gt(TETU_WHALE_THRESHOLD)
}

function choiceToChain (choice) {
  return choice.split('(')[1].split(')')[0]
}

function logSection (name) {
  if (process.env.NODE_ENV === 'development') {
    console.log('')
    console.log(chalk.blue.underline(name))
    console.log('')
  } else {
    const loading = document.getElementById('loading')
    if (loading) loading.parentNode.removeChild(loading)
    const node = document.createElement('h4')
    node.appendChild(document.createTextNode(name))
    document.body.appendChild(node)
  }
}

function logText (text) {
  if (process.env.NODE_ENV === 'development') {
    console.log(text)
  } else {
    const node = document.createElement('p')
    node.appendChild(document.createTextNode(text))
    document.body.appendChild(node)
  }
}

function logTable (data) {
  data = cloneDeep(data)

  // format numbers, etc
  if (Array.isArray(data)) {
    for (const i in data) {
      for (const [k, v] of Object.entries(data[i])) {
        if (v instanceof BigNumber) {
          data[i][k] = v.toFixed(k === 'qiPerBlock' ? null : 2)
        }
      }
    }
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof BigNumber) {
        data[k] = v.toFixed(2)
      }

      for (const [y, z] of Object.entries(v)) {
        if (z instanceof BigNumber) {
          v[y] = z.toFixed(2)
        }
      }
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.table(data)
  } else {
    const node = document.createElement('div')
    node.innerHTML = tableify(data)
    document.body.appendChild(node)
  }
}

async function getAllVotes (proposalId) {
  const votes = []

  let i = 0
  while (true) {
    const resp = await request(GRAPHQL_ENDPOINT, gql`
      query {
        votes (
          first: ${PAGE_SIZE}
          skip: ${i * PAGE_SIZE}
          where: {
            proposal: "${proposalId}"
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
    `)
    votes.push(...resp.votes)

    if (resp.votes.length === PAGE_SIZE) {
      i++
    } else {
      break
    }
  }

  return votes
}

async function getProposalChoices () {
  const proposalResp = await request(GRAPHQL_ENDPOINT, gql`
    query {
      proposals (
        where: {
          id: "${QIDAO_PROPOSAL_ID}"
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
  `)

  return ['', ...proposalResp.proposals[0].choices] // starts at idx = 1
}

async function main () {
  // Get subgraph data
  const choicesDict = await getProposalChoices()
  const votes = await getAllVotes(QIDAO_PROPOSAL_ID)
  const tetuVotes = await getAllVotes(TETU_REFLECTION_PROPOSAL_ID)

  // Set these up for later
  let ourChoicePercentage
  let ourChoiceVotes

  // Calculate vote totals
  const voteTotals = {}
  for (const vote of votes) {
    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (!voteTotals[choiceId]) voteTotals[choiceId] = BigNumber(0)
      voteTotals[choiceId] = BigNumber.sum(voteTotals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
    }
  }

  const totalVote = BigNumber.sum(...Object.values(voteTotals))

  const totalsArr = []
  const percentagesByChain = {}

  for (const [choiceId, sumVotes] of Object.entries(voteTotals)) {
    const percentage = sumVotes.div(totalVote).times(100)
    const chain = choiceToChain(choicesDict[choiceId])

    totalsArr.push({
      choice: choicesDict[choiceId],
      votes: sumVotes,
      percentage: percentage
    })

    if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
      ourChoiceVotes = sumVotes
      ourChoicePercentage = percentage
    }

    if (!percentagesByChain[chain]) percentagesByChain[chain] = BigNumber(0)
    percentagesByChain[chain] = BigNumber.sum(percentagesByChain[chain], percentage)
  }

  totalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

  // Display chain percentages in descending order
  const percentagesByChainArr = []
  for (const [chain, p] of Object.entries(percentagesByChain)) {
    percentagesByChainArr.push([chain, p])
  }
  percentagesByChainArr.sort((a, b) => BigNumber(a[1]).gt(b[1]) ? -1 : 1)

  // Simulate QI amounts, with chains that did not meet 8.33% removed:
  const totalsWithRedistribution = cloneDeep(totalsArr)
  for (const t of totalsWithRedistribution) {
    if (percentagesByChain[choiceToChain(t.choice)].lt(MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS)) {
      t.votes = BigNumber(0)
    }
  }
  const newTotalVotesAfterRedistribution = BigNumber.sum(...totalsWithRedistribution.map(t => t.votes))
  for (const t of totalsWithRedistribution) {
    t.percentage = t.votes.div(newTotalVotesAfterRedistribution).times(100)
    t.qiPerWeek = TOTAL_WEEKLY_QI.times(t.percentage).div(100)
    t.qiPerBlock = TOTAL_QI_PER_BLOCK.times(t.percentage).div(100)
  }

  // Check that our chain has > 8.33% of vote
  const ourBribedChain = choiceToChain(OUR_BRIBED_CHOICE)
  if (percentagesByChain[ourBribedChain].lt(MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS)) {
    throw new Error(`no bribes, ${ourBribedChain} did not cross threshold`)
  }

  // Figure out how much bribe we are paying based on the % of vote that we got
  const totalBribe = BigNumber(ourChoicePercentage).times(QI_BRIBE_PER_ONE_PERCENT)
  const bribes = {}

  // Calculate bribes for each voter
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
          choicePerc: percentageOfChoiceVote,
          bribeAmount: bribe
        }
      }
    }
  }

  // "Claw back" whale bribes
  let clawedBackWhaleBribeAmount = BigNumber(0)
  for (const i in bribes) {
    if (shouldClawBackWhale(i, bribes[i].voterVp)) {
      clawedBackWhaleBribeAmount = BigNumber.sum(clawedBackWhaleBribeAmount, bribes[i].bribeAmount)
    }
  }

  // Redistribute whale bribes to non-whales
  for (const i in bribes) {
    if (!shouldClawBackWhale(i, bribes[i].voterVp)) {
      bribes[i].whaleAdjust = BigNumber(bribes[i].choicePerc).times(clawedBackWhaleBribeAmount).times(WHALE_REDISTRIBUTION).div(100).div(100)
    } else {
      bribes[i].whaleAdjust = BigNumber(0).minus(bribes[i].bribeAmount)
    }

    if (shouldZeroBribe(i)) {
      bribes[i].whaleAdjust = BigNumber(0).minus(bribes[i].bribeAmount)
    }

    bribes[i].totalBribe = BigNumber.sum(bribes[i].bribeAmount, bribes[i].whaleAdjust)
    bribes[i].qiPerPercent = BigNumber(bribes[i].totalBribe).div(BigNumber(bribes[i].choicePerc).times(ourChoicePercentage).div(100))
  }

  // Calculate Tetu bribes
  const tetuTotalsArr = []
  const tetuBribe = bribes[TETU_ADDRESS]
  const tetuBribes = {}
  if (tetuBribe) {
    let ourTetuChoiceVotes

    const tetuVoteTotals = {}
    for (const vote of tetuVotes) {
      const totalWeight = BigNumber.sum(...Object.values(vote.choice))

      for (const [choiceId, weight] of Object.entries(vote.choice)) {
        if (!tetuVoteTotals[choiceId]) tetuVoteTotals[choiceId] = BigNumber(0)
        tetuVoteTotals[choiceId] = BigNumber.sum(tetuVoteTotals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
      }
    }

    const tetuTotalVote = BigNumber.sum(...Object.values(tetuVoteTotals))

    for (const [choiceId, sumVotes] of Object.entries(tetuVoteTotals)) {
      const percentage = sumVotes.div(tetuTotalVote).times(100)

      tetuTotalsArr.push({
        choice: choicesDict[choiceId],
        votes: sumVotes,
        percentage: percentage
      })

      if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
        ourTetuChoiceVotes = sumVotes
      }
    }

    tetuTotalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

    const tetuTotalBribe = tetuBribe.totalBribe

    // Calculate bribes for each voter
    for (const vote of tetuVotes) {
      if (vote.vp === 0) continue

      const totalWeight = BigNumber.sum(...Object.values(vote.choice))

      for (const [choiceId, weight] of Object.entries(vote.choice)) {
        if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
          const choiceVote = BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight)
          const percentageOfChoiceVote = choiceVote.div(ourTetuChoiceVotes).times(100)
          const bribe = BigNumber(tetuTotalBribe).times(percentageOfChoiceVote).div(100)
          tetuBribes[vote.voter] = {
            voterVp: vote.vp,
            choicePerc: percentageOfChoiceVote,
            bribeAmount: bribe
          }
        }
      }
    }

    // Remove whale bribes (do not redistribute)
    for (const i in tetuBribes) {
      if (shouldClawBackTetuWhale(tetuBribes[i].voterVp)) {
        tetuBribes[i].whaleAdjust = BigNumber(0).minus(tetuBribes[i].bribeAmount)
      } else {
        tetuBribes[i].whaleAdjust = BigNumber(0)
      }
      tetuBribes[i].totalBribe = BigNumber.sum(tetuBribes[i].bribeAmount, tetuBribes[i].whaleAdjust)
    }
  }

  // Calculate total bribes
  const sumBribes = BigNumber.sum(...Object.values(bribes).map(b => b.totalBribe))

  // Display:
  logSection(chalk.blue.underline('Current vote totals'))
  logTable(totalsArr)

  logSection(chalk.blue.underline('Vote totals by chain'))
  logTable(percentagesByChainArr)

  logSection(chalk.blue.underline('Clawed back whale bribes'))
  logText(`${clawedBackWhaleBribeAmount.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Our bribes'))
  logText(`${sumBribes.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Bribes by voter'))
  logTable(bribes)

  logSection(chalk.blue.underline(`Totals with redistribution of sub-${MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS.toFixed()}% chains`))
  logTable(totalsWithRedistribution)

  logSection(chalk.blue.underline('Tetu votes'))
  logTable(tetuTotalsArr)

  logSection(chalk.blue.underline('Tetu bribes'))
  logTable(tetuBribes)
}

main()
