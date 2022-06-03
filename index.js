const BigNumber = require('bignumber.js')
const { request, gql } = require('graphql-request')

const GRAPHQL_ENDPOINT = 'https://hub.snapshot.org/graphql'
const PROPOSAL_ID = '0xae009d3fc6517df8d2761a891be63a8a459e68e54d0b8043de176070a23ac51c'
const PAGE_SIZE = 1000

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

  for (const [choiceId, sumVotes] of Object.entries(totals)) {
    totalsArr.push({
      choice: choicesDict[choiceId],
      votes: sumVotes.toFixed(0),
      percentage: sumVotes.div(totalVote).times(100).toFixed(2) + ' %'
    })
  }

  totalsArr.sort((a, b) => BigNumber(a.votes).gt(b.votes) ? -1 : 1)

  console.table(totalsArr)
}

main()
