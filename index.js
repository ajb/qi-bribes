const chalk = require('chalk')
const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')
const tableify = require('tableify')
const cloneDeep = require('lodash.clonedeep')
const find = require('lodash.find')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const QIDAO_PROPOSAL_ID = '0xe32661e574a3238be9cbfe416c3284d09cb4d079f2a3ebf3449321553e078f2b'
// const TETU_REFLECTION_PROPOSAL_ID = '0x9f2f40578eeaac4a1420cce5a7947c63ce56a48fc095e34183eb590055190e8a'
const PAGE_SIZE = 1000
const QI_BRIBE_PER_ONE_PERCENT = BigNumber(1000)
// const TETU_ADDRESS = '0x0644141DD9C2c34802d28D334217bD2034206Bf7'
const MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS = BigNumber('8.333')
const TOTAL_WEEKLY_QI = BigNumber(180000)
const OUR_BRIBED_CHOICE = 'BAL (Polygon)'
// const OUR_BRIBED_CHOICE_TETU = 'BAL(Polygon)'
const MAX_PERCENT = BigNumber(20)
const MAX_BRIBE_IN_QI = QI_BRIBE_PER_ONE_PERCENT.times(MAX_PERCENT)

const KNOWN_BRIBES_PER_ONE_PERCENT = {
  'WBTC (Optimism)': BigNumber(1585),
  'WETH (Optimism)': BigNumber(1000),
  'BAL (Polygon)': QI_BRIBE_PER_ONE_PERCENT,
  'xxLINK (Polygon)': BigNumber(1000),
  'vGHST (Polygon)': BigNumber(800),
  'WBTC (Metis)': BigNumber(800)
}

function choiceToChain (choice) {
  return choice.split('(')[1].split(')')[0]
}

function getEnvVar (n) {
  if (typeof process === 'undefined') {
    return null
  }

  return process.env[n]
}

function logSection (name) {
  if (getEnvVar('NODE_ENV') === 'development') {
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
  if (getEnvVar('NODE_ENV') === 'development') {
    console.log(text)
  } else {
    const node = document.createElement('p')
    node.appendChild(document.createTextNode(text))
    document.body.appendChild(node)
  }
}

function logTable (data, voterHeaders) {
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

  if (getEnvVar('NODE_ENV') === 'development') {
    console.table(data)
  } else {
    if (voterHeaders) {
      for (const [k, v] of Object.entries(data)) {
        const h5 = document.createElement('h5')
        h5.innerText = k
        document.body.appendChild(h5)

        const node = document.createElement('div')
        node.className = 'tableWrapper'
        node.innerHTML = tableify(v)
        document.body.appendChild(node)
      }
    } else {
      const node = document.createElement('div')
      node.className = 'tableWrapper'
      node.innerHTML = tableify(data)
      document.body.appendChild(node)
    }
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

  if (proposalResp.proposals.length === 0) return []

  return ['', ...proposalResp.proposals[0].choices] // starts at idx = 1
}

async function main () {
  // update website
  if (getEnvVar('NODE_ENV') !== 'development') {
    document.getElementById('qiPerPercent').innerText = QI_BRIBE_PER_ONE_PERCENT.toString()
    document.getElementById('maxTotalBribe').innerText = MAX_BRIBE_IN_QI.toString()
    const url = 'https://snapshot.org/#/qidao.eth/proposal/' + QIDAO_PROPOSAL_ID.toString()
    document.getElementById('linkToSnapshot').innerText = url
    document.getElementById('linkToSnapshot').href = url
  }

  // Get subgraph data
  const choicesDict = await getProposalChoices(QIDAO_PROPOSAL_ID)
  // const tetuChoicesDict = await getProposalChoices(TETU_REFLECTION_PROPOSAL_ID)
  const votes = await getAllVotes(QIDAO_PROPOSAL_ID)
  // const tetuVotes = await getAllVotes(TETU_REFLECTION_PROPOSAL_ID)

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
  function getCurrentTotalVote () {
    return BigNumber.sum(...totalsArr.map(v => v.votes))
  }
  for (const [choiceId, sumVotes] of Object.entries(voteTotals)) {
    const oPercentage = sumVotes.div(totalVote).times(100)

    totalsArr.push({
      choice: choicesDict[choiceId],
      originalVotes: sumVotes,
      votes: sumVotes,
      oPercentage
    })
  }
  totalsArr.sort((a, b) => BigNumber(a.originalVotes).gt(b.originalVotes) ? -1 : 1)

  const percentagesByChain = {}
  for (const t of totalsArr) {
    percentagesByChain[choiceToChain(t.choice)] = percentagesByChain[choiceToChain(t.choice)] || BigNumber(0)
    percentagesByChain[choiceToChain(t.choice)] = percentagesByChain[choiceToChain(t.choice)].plus(
      t.votes.div(totalVote).times(100)
    )
  }

  // Display chain percentages in descending order
  const percentagesByChainArr = []
  for (const [chain, p] of Object.entries(percentagesByChain)) {
    percentagesByChainArr.push([chain, p])
  }
  percentagesByChainArr.sort((a, b) => BigNumber(a[1]).gt(b[1]) ? -1 : 1)

  // remove chains with less than 8.3%
  for (const t of totalsArr) {
    const chain = choiceToChain(t.choice)
    if (percentagesByChain[chain].lt(MIN_PERCENTAGE_FOR_CHAIN_TO_RECEIVE_REWARDS)) {
      t.votes = BigNumber(0)
    }
  }

  // calculate new percentages
  for (const t of totalsArr) {
    t.pAfterChain = t.votes.div(getCurrentTotalVote()).times(100)
    t.pCapped = BigNumber.min(20, t.pAfterChain)
  }

  const totalCappedPercentages = BigNumber.sum(...totalsArr.map(t => t.pCapped))

  for (const t of totalsArr) {
    t.percentage = t.pCapped.div(totalCappedPercentages).times(100)
  }

  // add known bribes
  for (const t of totalsArr) {
    t.totalBribe = KNOWN_BRIBES_PER_ONE_PERCENT[t.choice] ? KNOWN_BRIBES_PER_ONE_PERCENT[t.choice].times(BigNumber.min(t.percentage, 20, t.oPercentage)) : BigNumber(0)
    t.votersReceive = t.totalBribe.div(t.oPercentage).toFixed(2) + ' QI/1%'
  }

  // add qi per week
  for (const t of totalsArr) {
    t.totalWeeklyQi = TOTAL_WEEKLY_QI.times(t.percentage).div(100)
  }

  // Calculate bribes for each voter
  const bribes = {}
  for (const vote of votes) {
    if (vote.vp === 0) continue

    const totalWeight = BigNumber.sum(...Object.values(vote.choice))

    let totalChoicePercent = BigNumber(0)
    for (const [choiceId, weight] of Object.entries(vote.choice)) {
      if (choicesDict[choiceId] === OUR_BRIBED_CHOICE) {
        totalChoicePercent = totalChoicePercent.plus(BigNumber(weight).div(totalWeight))
      }
    }
    if (totalChoicePercent.eq(0)) continue
    bribes[vote.voter] = {
      vp: vote.vp,
      choicePercent: totalChoicePercent,
      choiceVp: totalChoicePercent.times(vote.vp)
    }
  }

  // Get total choice VP
  const totalChoiceVp = BigNumber.sum(...Object.values(bribes).map(b => b.choiceVp))
  const totalBribe = find(totalsArr, t => t.choice === OUR_BRIBED_CHOICE).totalBribe

  for (const i in bribes) {
    bribes[i].bribeAmount = bribes[i].choiceVp.div(totalChoiceVp).times(totalBribe)
  }

  // Calculate Tetu bribes
  // const tetuTotalsArr = []
  // const tetuVote = find(votes, v => v.voter === TETU_ADDRESS)

  // const tetuBribes = {}
  // let ourTetuChoiceVotes = BigNumber(0)

  // const tetuVoteTotals = {}
  // for (const vote of tetuVotes) {
  //   if (vote.vp === 0) continue
  //   const totalWeight = BigNumber.sum(...Object.values(vote.choice))

  //   for (const [choiceId, weight] of Object.entries(vote.choice)) {
  //     if (!tetuVoteTotals[choiceId]) tetuVoteTotals[choiceId] = BigNumber(0)
  //     tetuVoteTotals[choiceId] = BigNumber.sum(tetuVoteTotals[choiceId], BigNumber(vote.vp).times(BigNumber(weight)).div(totalWeight))
  //   }
  // }

  // const tetuTotalVote = BigNumber.sum(...Object.values(tetuVoteTotals))

  // for (const [choiceId, sumVotes] of Object.entries(tetuVoteTotals)) {
  //   const choiceStr = tetuChoicesDict[choiceId]
  //   const percentage = sumVotes.div(tetuTotalVote).times(100)

  //   tetuTotalsArr.push({
  //     choice: choiceStr,
  //     votes: sumVotes,
  //     percentage: percentage
  //   })

  //   if (choiceStr === OUR_BRIBED_CHOICE_TETU[0]) {
  //     ourTetuChoiceVotes = ourTetuChoiceVotes.plus(sumVotes)
  //   }
  // }

  // tetuTotalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

  // // Calculate bribes for each voter
  // let tetuTotalVp = BigNumber(0)
  // let tetuBribedVp = BigNumber(0)
  // for (const vote of tetuVotes) {
  //   tetuTotalVp = tetuTotalVp.plus(vote.vp)

  //   if (vote.vp === 0) continue

  //   const totalWeight = BigNumber.sum(...Object.values(vote.choice))

  //   let totalChoicePercent = BigNumber(0)
  //   for (const [choiceId, weight] of Object.entries(vote.choice)) {
  //     if (tetuChoicesDict[choiceId] === OUR_BRIBED_CHOICE_TETU) {
  //       totalChoicePercent = totalChoicePercent.plus(BigNumber(weight).div(totalWeight))
  //     }
  //   }
  //   if (totalChoicePercent.eq(0)) continue
  //   tetuBribes[vote.voter] = {
  //     vp: vote.vp,
  //     choicePercent: totalChoicePercent,
  //     choiceVp: totalChoicePercent.times(vote.vp)
  //   }

  //   tetuBribedVp = tetuBribedVp.plus(tetuBribes[vote.voter].choiceVp)
  // }

  // // get the % of the tetu vote that voted 50/50 and receives bribes

  // const percentTetuVoteBribed = tetuBribedVp.div(tetuTotalVp)

  // // determine the total qidao vote % that this amount of votes was responsible for
  // let tetuTotalBribe
  // if (tetuVote) {
  //   const tetuQiBribedVp = BigNumber(tetuVote.vp).times(percentTetuVoteBribed)
  //   const tetuQiPercent = tetuQiBribedVp.div(totalVote).times(100)
  //   tetuTotalBribe = QI_BRIBE_PER_ONE_PERCENT.times(tetuQiPercent)

  //   for (const i in tetuBribes) {
  //     const percentOfTetuVote = tetuBribes[i].choiceVp.div(tetuTotalVp)
  //     tetuBribes[i].bribeAmount = percentOfTetuVote.times(tetuTotalBribe)
  //   }
  // } else {
  //   for (const i in tetuBribes) {
  //     tetuBribes[i].bribeAmount = 'pending'
  //   }
  // }

  // Display:
  logSection(chalk.blue.underline('Vote totals'))
  logTable(totalsArr)

  logSection(chalk.blue.underline('Vote totals by chain'))
  logTable(percentagesByChainArr)

  logSection(chalk.blue.underline('Our bribes'))
  logText(`${totalBribe.toFixed(2)} QI`)

  logSection(chalk.blue.underline('Bribes by voter'))
  logTable(bribes, true)

  // logSection(chalk.blue.underline('Tetu votes'))
  // logTable(tetuTotalsArr)

  // logSection(chalk.blue.underline('Tetu total bribe'))
  // logText(tetuTotalBribe ? `${tetuTotalBribe.toFixed(2)} QI` : '-')

  // logSection(chalk.blue.underline('Tetu bribes'))
  // logTable(tetuBribes, true)

  // if (getEnvVar('LOG_CSV')) {
  //   logSection(chalk.blue.underline('CSV for disperse.app'))
  //   const rows = []

  //   for (const [a, b] of Object.entries(bribes)) {
  //     if (b.bribeAmount.gt(0)) rows.push([a, b.bribeAmount.toFixed(10)])
  //   }

  //   for (const [a, b] of Object.entries(tetuBribes)) {
  //     if (b.bribeAmount.gt(0)) rows.push([a, b.bribeAmount.toFixed(10)])
  //   }

  //   console.log(rows.map(row => `${row[0]}=${row[1]}`).join('\n'))
  // }
}

main()
