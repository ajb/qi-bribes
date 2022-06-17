const chalk = require('chalk')
const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')
const tableify = require('tableify')
const cloneDeep = require('lodash.clonedeep')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const QIDAO_PROPOSAL_ID = '0xc7f724eb3473316aef7d0fa7c81d3a50614760cd82ada0c1a08eab6c16e53fda'
const TETU_REFLECTION_PROPOSAL_ID = '0xf6f2a222da1e54d521e731e9f0e4ddacf980254bbcbaae535aedfa10b01d7563'
const PAGE_SIZE = 1000
const QI_BRIBE_PER_ONE_PERCENT = BigNumber(800)
const TETU_ADDRESS = '0x0644141DD9C2c34802d28D334217bD2034206Bf7'
const MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS = BigNumber('8.333')
const TOTAL_WEEKLY_QI = BigNumber(180000)
const TOTAL_QI_PER_BLOCK = BigNumber(0.65)
const OUR_BRIBED_CHOICES = ['WBTC (Arbitrum)', 'WBTC (Optimism) ']
const OUR_BRIBED_CHOICES_TETU = ['WBTC(Optimism)', 'WBTC(Arbitrum)']

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

async function getProposalChoices (proposalId) {
  const proposalResp = await request(GRAPHQL_ENDPOINT, gql`
    query {
      proposals (
        where: {
          id: "${proposalId}"
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
  function hasSameWeightsForBothChoices (voteChoice) {
    const idxs = []
    for (const c of OUR_BRIBED_CHOICES) {
      idxs.push(choicesDict.indexOf(c))
    }

    return voteChoice[idxs[0]] && voteChoice[idxs[1]] && voteChoice[idxs[0]] === voteChoice[idxs[1]]
  }

  function hasSameWeightsForBothTetuChoices (voteChoice) {
    const idxs = []
    for (const c of OUR_BRIBED_CHOICES_TETU) {
      idxs.push(tetuChoicesDict.indexOf(c))
    }

    return voteChoice[idxs[0]] && voteChoice[idxs[1]] && voteChoice[idxs[0]] === voteChoice[idxs[1]]
  }

  // Get subgraph data
  const choicesDict = await getProposalChoices(QIDAO_PROPOSAL_ID)
  const tetuChoicesDict = await getProposalChoices(TETU_REFLECTION_PROPOSAL_ID)
  const votes = await getAllVotes(QIDAO_PROPOSAL_ID)
  const tetuVotes = await getAllVotes(TETU_REFLECTION_PROPOSAL_ID)

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
  // if (!process.env.SKIP_THRESHOLD_CHECK) {
  //   const ourBribedChainOne = choiceToChain(OUR_BRIBED_CHOICES[0])
  //   if (percentagesByChain[ourBribedChainOne].lt(MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS)) {
  //     throw new Error(`no bribes, ${ourBribedChainOne} did not cross threshold`)
  //   }

  //   // Check that our other chain has > 8.33% of vote
  //   const ourBribedChainTwo = choiceToChain(OUR_BRIBED_CHOICES[1])
  //   if (percentagesByChain[ourBribedChainTwo].lt(MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS)) {
  //     throw new Error(`no bribes, ${ourBribedChainTwo} did not cross threshold`)
  //   }
  // }

  // Calculate bribes for each voter
  const bribes = {}
  for (const vote of votes) {
    if (vote.vp === 0) continue

    if (!hasSameWeightsForBothChoices(vote.choice)) continue

    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    let totalChoicePercent = BigNumber(0)
    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (choicesDict[choiceId] === OUR_BRIBED_CHOICES[0] || choicesDict[choiceId] === OUR_BRIBED_CHOICES[1]) {
        totalChoicePercent = totalChoicePercent.plus(BigNumber(weight).div(totalWeight))
      }
    }
    bribes[vote.voter] = {
      vp: vote.vp,
      choicePercent: totalChoicePercent,
      choiceVp: totalChoicePercent.times(vote.vp)
    }
  }

  // Get total 50/50 choice VP
  const totalChoiceVp = BigNumber.sum(...Object.values(bribes).map(b => b.choiceVp))
  const totalFiftyFiftyPercent = totalChoiceVp.div(totalVote).times(100)
  const totalBribe = QI_BRIBE_PER_ONE_PERCENT.times(totalFiftyFiftyPercent)

  for (const i in bribes) {
    bribes[i].bribeAmount = bribes[i].choiceVp.div(totalChoiceVp).times(totalBribe)
  }

  // Calculate Tetu bribes
  const tetuTotalsArr = []

  // TODO: this is just for testing
  // switch these back once Tetu submits their vote
  const tetuBribe = bribes[TETU_ADDRESS]
  // const tetuBribe = bribes['0x773743e9e4d124D7B79c98799DA8c1E14f032080']

  const tetuBribes = {}
  if (tetuBribe) {
    let ourTetuChoiceVotes = BigNumber(0)

    const tetuVoteTotals = {}
    for (const vote of tetuVotes) {
      if (vote.vp === 0) continue
      const totalWeight = BigNumber.sum(...Object.values(vote.choice))

      for (const [choiceId, weight] of Object.entries(vote.choice)) {
        if (!tetuVoteTotals[choiceId]) tetuVoteTotals[choiceId] = BigNumber(0)
        tetuVoteTotals[choiceId] = BigNumber.sum(tetuVoteTotals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
      }
    }

    const tetuTotalVote = BigNumber.sum(...Object.values(tetuVoteTotals))

    for (const [choiceId, sumVotes] of Object.entries(tetuVoteTotals)) {
      const choiceStr = tetuChoicesDict[choiceId]
      const percentage = sumVotes.div(tetuTotalVote).times(100)

      tetuTotalsArr.push({
        choice: choiceStr,
        votes: sumVotes,
        percentage: percentage
      })

      if (choiceStr === OUR_BRIBED_CHOICES_TETU[0] || choiceStr === OUR_BRIBED_CHOICES_TETU[1]) {
        ourTetuChoiceVotes = ourTetuChoiceVotes.plus(sumVotes)
      }
    }

    tetuTotalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

    const tetuTotalBribe = tetuBribe.bribeAmount

    // Calculate bribes for each voter
    for (const vote of tetuVotes) {
      console.log(vote)
      if (vote.vp === 0) continue

      if (!hasSameWeightsForBothTetuChoices(vote.choice)) continue

      const totalWeight = BigNumber.sum(...Object.values(vote.choice))

      let totalChoicePercent = BigNumber(0)
      for (const [choiceId, weight] of Object.entries(vote.choice)) {
        if (tetuChoicesDict[choiceId] === OUR_BRIBED_CHOICES_TETU[0] || tetuChoicesDict[choiceId] === OUR_BRIBED_CHOICES_TETU[1]) {
          totalChoicePercent = totalChoicePercent.plus(BigNumber(weight).div(totalWeight))
        }
      }
      tetuBribes[vote.voter] = {
        vp: vote.vp,
        choicePercent: totalChoicePercent,
        choiceVp: totalChoicePercent.times(vote.vp)
      }
    }

    // Get total 50/50 choice VP
    const totalChoiceVp = BigNumber.sum(...Object.values(tetuBribes).map(b => b.choiceVp))
    for (const i in tetuBribes) {
      tetuBribes[i].bribeAmount = tetuBribes[i].choiceVp.div(totalChoiceVp).times(tetuTotalBribe)
    }
  }

  // Display:
  logSection(chalk.blue.underline('Current vote totals'))
  logTable(totalsArr)

  logSection(chalk.blue.underline('Vote totals by chain'))
  logTable(percentagesByChainArr)

  logSection(chalk.blue.underline('Our bribes'))
  logText(`${totalBribe.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Bribes by voter'))
  logTable(bribes)

  logSection(chalk.blue.underline('Tetu votes'))
  logTable(tetuTotalsArr)

  logSection(chalk.blue.underline('Tetu bribes'))
  logTable(tetuBribes)

  if (process.env.NODE_ENV === 'development') {
    logSection(chalk.blue.underline(`Totals with redistribution of sub-${MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS.toFixed()}% chains`))
    logTable(totalsWithRedistribution)
  }

  // if (process.env.LOG_CSV) {
  //   logSection(chalk.blue.underline('CSV for disperse.app'))
  //   const rows = []

  //   for (const [a, b] of Object.entries(bribes)) {
  //     if (a === TETU_ADDRESS) continue
  //     if (b.totalBribe.gt(0)) rows.push([a, b.totalBribe.toFixed(10)])
  //   }

  //   for (const [a, b] of Object.entries(tetuBribes)) {
  //     if (b.totalBribe.gt(0)) rows.push([a, b.totalBribe.toFixed(10)])
  //   }

  //   console.log(rows.map(row => `${row[0]}=${row[1]}`).join('\n'))
  // }
}

main()
