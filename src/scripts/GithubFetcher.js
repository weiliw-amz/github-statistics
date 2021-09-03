import {  } from 'graphql'
import { GraphQLClient } from 'graphql-request'

const getProgress = (c, t) => t === 0 ? 100 : Math.floor(c / t * 100)

/**
 * Reformat the fetched data: 
 * Map: date(Date) -> daily_count(int) to 
 * Map: cum_days(int) -> daily_count(int)
 * @param {Map<date, int>} formattedData 
 */
function reformat_date_cumdays(formattedData) {
  const _MS_PER_DAY = 1000 * 60 * 60 * 24;
  let reformattedData = new Map();

  let date_arr = Array.from(formattedData.keys())
  let start_date = Math.min.apply( Math, date_arr)
  // console.log(start_date)

  formattedData.forEach((value, key) => {    
    reformattedData.set(Math.floor((key - start_date) / _MS_PER_DAY), value);
  })

  return reformattedData
}

class GithubFetcher {

  constructor(token) {
    const endpoint = 'https://api.github.com/graphql'

    this.gqlClient = new GraphQLClient(
      endpoint,
      {
        headers: {
          Authorization: 'bearer ' + window.atob(token),
        }
      }
    )

    // configurations
    this.liveUpdate = false
    this.pagesPerUpdate = 20
  }

  /**
   * test if the repository exists
   * @param owner owner of the repository
   * @param name of the repository
   * @param onResult (@param result) function that will be called when test finishes
   * @return false if not exist, true otherwise
   */
  // testRepository = async (owner, name, onResult) => {
  //   const variables = {
  //     owner: owner,
  //     name: name,
  //   }

  //   const query = /* GraphQL */ `
  //     query getRepository($owner: String!, $name: String!){
  //       repository(owner: $owner, name: $name) {
  //         id
  //       }
  //     }
  //   `

  //   try {
  //     await this.gqlClient.request(query, variables)
  //   } catch (error) {
  //     if (onResult) {
  //       onResult(false)
  //     }
  //     return false
  //   }

  //   if (onResult) onResult(true)
  //   return true
  // }

  /**
   * suggest possible repositories based on current input
   * @param onResult (@param result) function that will be called when search finishes
   */
  searchRepository = async (input, onResult) => {
    const variables = {
      query: input,
    }

    const query = /* GraphQL */ `
      query searchRepository($query: String!){
        search(query: $query, first: 5, type: REPOSITORY) {
          codeCount
          nodes {
            ...on Repository {
              nameWithOwner
            }
          }
        }
      }
    `
    let formattedData = []

    const data = await this.gqlClient.request(query, variables)

    data.search.nodes.forEach(repo => formattedData.push(repo.nameWithOwner))

    if (onResult) onResult(formattedData)

    return formattedData
  }

  /**
   * fetch repository low-level data
   * @param owner owner of the repository
   * @param name name of the repository
   * @param onUpdate (data) function that will be called when a new data update is avaiable
   * @param onFinish (stats) function that will be called when fetching is finished
   * @param onProgress (progress) function that will be called when progress is updated
   * @param shouldAbort function that returns a boolean which determines whether fetching should abort
   * @returns Object that contains statistics
   */
  fetchRepositoryData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const variables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const query = /* GraphQL */ `
      query getRepository($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          nameWithOwner
          createdAt
          primaryLanguage {
            name
          }
          pushedAt
          watchers(first: 0) {
            totalCount
          }
        }
      }
    `

    // update progress tracking
    if (onProgress) onProgress(10)

    const data = await this.gqlClient.request(query, variables)
    // if (shouldAbort) {
    //   if (shouldAbort()) {
    //     return
    //   }
    // }

    const formattedData = {
      name: data.repository.nameWithOwner,
      createdAt: data.repository.createdAt,
      primaryLanguage: data.repository.primaryLanguage.name,
      pushedAt: data.repository.pushedAt,
      watcherCount: data.repository.watchers.totalCount,
    }

    // update progress tracking
    if (onProgress) onProgress(100)

    if (onFinish) onFinish(formattedData)

    return formattedData
  }

  /**
   * fetch repository low-level data
   * @param owner owner of the repository
   * @param name name of the repository
   * @param onUpdate (data) function that will be called when a new data update is avaiable
   * @param onFinish (stats) function that will be called when fetching is finished
   * @param onProgress (progress) function that will be called when progress is updated
   * @param shouldAbort function that returns a boolean which determines whether fetching should abort
   * @returns Object that contains statistics
   */
  fetchStargazerData = async (owner, name, onUpdate = () => {}, onFinish, onProgress, shouldAbort) => {
    const preparationVariables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const preparationQuery = /* GraphQL */ `
      query prepareStargazers($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          createdAt
          stargazers(first: 100) {
            totalCount
          }
        }
      }
    `
    const query = /* GraphQL */ `
      query getStargazers($owner: String!, $name: String!, $previousEndCursor: String){
        repository(owner: $owner, name: $name) {
          stargazers(first: 100, after: $previousEndCursor) {
            pageInfo {
              endCursor
              hasNextPage
            }
            edges {
              starredAt
            }
          }
        }
      }
    `

    // local variables
    const formattedData = new Map()
    let pageIndex = 0
    let totalToFetch = 0
    let maxIncrement = 0
    let numberFetched = 0
    let previousEndCursor = null
    let hasNextPage = false

    // Preparation query
    const preparationData = await this.gqlClient.request(preparationQuery, preparationVariables)

    // from preparation
    totalToFetch = preparationData.repository.stargazers.totalCount
    const createdAt = preparationData.repository.createdAt

    const handleEdge = edge => {
      const date = new Date(edge.starredAt.slice(0,10)).getTime() // ISO-8601 encoded UTC date string
      if (!formattedData.has(date)) {
        formattedData.set(date, 1)
      } else {
        formattedData.set(date, formattedData.get(date) + 1)
      }
      if (formattedData.get(date) > maxIncrement) maxIncrement = formattedData.get(date)
      // update progress tracking
      numberFetched += 1
    }

    // data traversal, 100 edges/request
    do {
      if (shouldAbort) if (shouldAbort()) return

      const variables = {
        owner: owner,
        name: name,
        previousEndCursor: previousEndCursor
      }
      // query for data
      const data = await new Promise(resolve => {
        const _data = this.gqlClient.request(query, variables)
        setTimeout(() => resolve(_data), 255)
      })

      data.repository.stargazers.edges.forEach(handleEdge)

      // update progress tracking
      if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))

      // track loop-level variables
      previousEndCursor = data.repository.stargazers.pageInfo.endCursor
      hasNextPage = data.repository.stargazers.pageInfo.hasNextPage
      // update pageIndex
      pageIndex += 1
      // onUpdate callback if existed
      if (this.liveUpdate && onUpdate && pageIndex % this.pagesPerUpdate === 0) {
        onUpdate(reformat_date_cumdays(formattedData))
      }
    } while (hasNextPage)
    if (onUpdate) onUpdate(reformat_date_cumdays(formattedData))
    if (onFinish) onFinish({
      total: totalToFetch,
      maxIncrement,
      createdAt,
    })
 
    return reformat_date_cumdays(formattedData)
  }

  /**
   * fetch fork data
   * @param owner owner of the repository
   * @param name name of the repository
   * @param onUpdate (data) function that will be called when a new data update is avaiable
   * @param onFinish (stats) function that will be called when fetching is finished
   * @param onProgress (progress) function that will be called when progress is updated
   * @param shouldAbort function that returns a boolean which determines whether fetching should abort
   * @returns Object that contains statistics
   */
  fetchForkData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const preparationVariables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const preparationQuery = /* GraphQL */ `
      query prepareForks($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          createdAt
          forkCount
          forks(first: 0) {
            totalCount
          }
        }
      }
    `
    const query = /* GraphQL */ `
      query getForks($owner: String!, $name: String!, $previousEndCursor: String){
        repository(owner: $owner, name: $name) {
          forks(first: 100, after: $previousEndCursor) {
            pageInfo {
              endCursor
              hasNextPage
            }
            nodes {
              createdAt
            }
          }
        }
      }
    `

    // local variables
    const formattedData = new Map()
    let pageIndex = 0
    let totalToFetch = 0
    let maxIncrement = 0
    let numberFetched = 0
    let previousEndCursor = null
    let hasNextPage = false

    // Preparation query
    const preparationData = await this.gqlClient.request(preparationQuery, preparationVariables)

    // from preparation
    totalToFetch = preparationData.repository.forks.totalCount
    const createdAt = preparationData.repository.createdAt



    const handleNode = node => {
      const date = new Date(node.createdAt.slice(0,10)).getTime() // ISO-8601 encoded UTC date string
      if (!formattedData.has(date)) {
        formattedData.set(date, 1)
      } else {
        formattedData.set(date, formattedData.get(date) + 1)
      }
      if (formattedData.get(date) > maxIncrement) maxIncrement = formattedData.get(date)
      // update progress tracking
      numberFetched += 1
    }

    // data traversal, 100 edges/request
    do {
      if (shouldAbort) if (shouldAbort()) return

      const variables = {
        owner: owner,
        name: name,
        previousEndCursor: previousEndCursor
      }
      // query for data
      const data = await this.gqlClient.request(query, variables)

      data.repository.forks.nodes.forEach(handleNode)

      // update progress tracking
      if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))

      // track loop-level variables
      previousEndCursor = data.repository.forks.pageInfo.endCursor
      hasNextPage = data.repository.forks.pageInfo.hasNextPage

      // update pageIndex
      pageIndex += 1

      // onUpdate callback if existed
      if (this.liveUpdate && onUpdate && pageIndex % this.pagesPerUpdate === 0) {
        onUpdate(reformat_date_cumdays(formattedData))
      }
    } while (hasNextPage)

    if (onUpdate) onUpdate(reformat_date_cumdays(formattedData))
    if (onFinish) onFinish({
      total: totalToFetch,
      maxIncrement,
      createdAt,
    })

    return reformat_date_cumdays(formattedData)
  }

  /**
 * fetch repository low-level data
 * @param owner owner of the repository
 * @param name name of the repository
 * @param onUpdate (data) function that will be called when a new data update is avaiable
 * @param onFinish (stats) function that will be called when fetching is finished
 * @param onProgress (progress) function that will be called when progress is updated
 * @param shouldAbort function that returns a boolean which determines whether fetching should abort
 * @returns Object that contains statistics
 */
  fetchRequestsData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const preparationVariables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const preparationQuery = /* GraphQL */ `
      query prepareForks($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          createdAt
          forkCount
          pullRequests(first: 0) {
            totalCount
          }
        }
      }
    `
    const query = /* GraphQL */ `
      query getForks($owner: String!, $name: String!, $previousEndCursor: String){
        repository(owner: $owner, name: $name) {
          pullRequests(first: 100, after: $previousEndCursor) {
            pageInfo {
              endCursor
              hasNextPage
            }
            nodes {
              createdAt
            }
          }
        }
      }
    `

    // local variables
    const formattedData = new Map()
    let pageIndex = 0
    let totalToFetch = 0
    let maxIncrement = 0
    let numberFetched = 0
    let previousEndCursor = null
    let hasNextPage = false

    // Preparation query
    const preparationData = await this.gqlClient.request(preparationQuery, preparationVariables)

    // from preparation
    totalToFetch = preparationData.repository.pullRequests.totalCount
    const createdAt = preparationData.repository.createdAt



    const handleNode = node => {
      const date = new Date(node.createdAt.slice(0, 10)).getTime() // ISO-8601 encoded UTC date string
      if (!formattedData.has(date)) {
        formattedData.set(date, 1)
      } else {
        formattedData.set(date, formattedData.get(date) + 1)
      }
      if (formattedData.get(date) > maxIncrement) maxIncrement = formattedData.get(date)
      // update progress tracking
      numberFetched += 1
    }

    // data traversal, 100 edges/request
    do {
      if (shouldAbort) if (shouldAbort()) return

      const variables = {
        owner: owner,
        name: name,
        previousEndCursor: previousEndCursor
      }
      // query for data
      const data = await this.gqlClient.request(query, variables)

      data.repository.pullRequests.nodes.forEach(handleNode)

      // update progress tracking
      if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))

      // track loop-level variables
      previousEndCursor = data.repository.pullRequests.pageInfo.endCursor
      hasNextPage = data.repository.pullRequests.pageInfo.hasNextPage

      // update pageIndex
      pageIndex += 1

      // onUpdate callback if existed
      if (this.liveUpdate && onUpdate && pageIndex % this.pagesPerUpdate === 0) {
        onUpdate(reformat_date_cumdays(formattedData))
      }
    } while (hasNextPage)

    if (onUpdate) onUpdate(reformat_date_cumdays(formattedData))
    if (onFinish) onFinish({
      total: totalToFetch,
      maxIncrement,
      createdAt,
    })

    return reformat_date_cumdays(formattedData)
  }

  /**
 * fetch repository low-level data
 * @param owner owner of the repository
 * @param name name of the repository
 * @param onUpdate (data) function that will be called when a new data update is avaiable
 * @param onFinish (stats) function that will be called when fetching is finished
 * @param onProgress (progress) function that will be called when progress is updated
 * @param shouldAbort function that returns a boolean which determines whether fetching should abort
 * @returns Object that contains statistics
 */
  fetchIssuesData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const preparationVariables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const preparationQuery = /* GraphQL */ `
      query prepareForks($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          createdAt
          forkCount
          issues(first: 0) {
            totalCount
          }
        }
      }
    `
    const query = /* GraphQL */ `
      query getForks($owner: String!, $name: String!, $previousEndCursor: String){
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $previousEndCursor) {
            pageInfo {
              endCursor
              hasNextPage
            }
            nodes {
              createdAt
            }
          }
        }
      }
    `

    // local variables
    const formattedData = new Map()
    let pageIndex = 0
    let totalToFetch = 0
    let maxIncrement = 0
    let numberFetched = 0
    let previousEndCursor = null
    let hasNextPage = false

    // Preparation query
    const preparationData = await this.gqlClient.request(preparationQuery, preparationVariables)

    // from preparation
    totalToFetch = preparationData.repository.issues.totalCount
    const createdAt = preparationData.repository.createdAt



    const handleNode = node => {
      const date = new Date(node.createdAt.slice(0, 10)).getTime() // ISO-8601 encoded UTC date string
      if (!formattedData.has(date)) {
        formattedData.set(date, 1)
      } else {
        formattedData.set(date, formattedData.get(date) + 1)
      }
      if (formattedData.get(date) > maxIncrement) maxIncrement = formattedData.get(date)
      // update progress tracking
      numberFetched += 1
    }

    // data traversal, 100 edges/request
    do {
      if (shouldAbort) if (shouldAbort()) return

      const variables = {
        owner: owner,
        name: name,
        previousEndCursor: previousEndCursor
      }
      // query for data
      const data = await this.gqlClient.request(query, variables)

      data.repository.issues.nodes.forEach(handleNode)

      // update progress tracking
      if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))

      // track loop-level variables
      previousEndCursor = data.repository.issues.pageInfo.endCursor
      hasNextPage = data.repository.issues.pageInfo.hasNextPage

      // update pageIndex
      pageIndex += 1

      // onUpdate callback if existed
      if (this.liveUpdate && onUpdate && pageIndex % this.pagesPerUpdate === 0) {
        onUpdate(reformat_date_cumdays(formattedData))
      }
    } while (hasNextPage)

    if (onUpdate) onUpdate(reformat_date_cumdays(formattedData))
    if (onFinish) onFinish({
      total: totalToFetch,
      maxIncrement,
      createdAt,
    })

    return reformat_date_cumdays(formattedData)
  }

  /**
   * fetch repository low-level data
   * @param owner owner of the repository
   * @param name name of the repository
   * @param onUpdate (data) function that will be called when a new data update is avaiable
   * @param onFinish (stats) function that will be called when fetching is finished
   * @param onProgress (progress) function that will be called when progress is updated
   * @param shouldAbort function that returns a boolean which determines whether fetching should abort
   * @returns Object that contains statistics
   */
  fetchCommitData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const preparationVariables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const preparationQuery = /* GraphQL */ `
      query prepareCommits($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            # name
            target {
              ... on Commit {
                oid
                committedDate
                history {
                  totalCount
                }
              }
            }
          }
        }
      }
    `
    const query = /* GraphQL */ `
      query getCommits($owner: String!, $name: String!, $previousEndCursor: String, $oid: GitObjectID!, $since: GitTimestamp!){
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              history(first: 100, after: $previousEndCursor, since: $since ) {
                totalCount
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  committedDate
                  # message
                }
              }
            }
          }
        }
      }
    `


    // local variables
    const formattedData = new Map()
    let pageIndex = 0
    let totalToFetch = 0
    let numberFetched = 0
    let maxIncrement = 0
    let previousEndCursor = null
    let hasNextPage = false

    // Preparation query
    const preparationData = await this.gqlClient.request(preparationQuery, preparationVariables)

    // from preparation
    totalToFetch = preparationData.repository.defaultBranchRef.target.history.totalCount
    const headRefOid = preparationData.repository.defaultBranchRef.target.oid
    const since = new Date(new Date(preparationData.repository.defaultBranchRef.target.committedDate)
      .setFullYear(new Date(preparationData.repository.defaultBranchRef.target.committedDate).getFullYear() - 1))
      .toISOString()

    const handleNode = node => {
      const date = new Date(node.committedDate.slice(0,10)).getTime() // ISO-8601 encoded UTC date string
      if (!formattedData.has(date)) {
        formattedData.set(date, 1)
      } else {
        formattedData.set(date, formattedData.get(date) + 1)
      }
      if (formattedData.get(date) > maxIncrement) maxIncrement = formattedData.get(date)
      // update progress tracking
      numberFetched += 1
    }

    // data traversal, 100 edges/request
    do {
      if (shouldAbort) if (shouldAbort()) return

      const variables = {
        owner: owner,
        name: name,
        oid: headRefOid,
        since: since,
        previousEndCursor: previousEndCursor
      }
      // query for data
      const data = await this.gqlClient.request(query, variables)

      totalToFetch = data.repository.object.history.totalCount
      data.repository.object.history.nodes.forEach(handleNode)

      // update progress tracking
      if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))

      // track loop-level variables
      previousEndCursor = data.repository.object.history.pageInfo.endCursor
      hasNextPage = data.repository.object.history.pageInfo.hasNextPage
      // update pageIndex
      pageIndex += 1

      // onUpdate callback if existed
      if (this.liveUpdate && onUpdate && pageIndex % this.pagesPerUpdate === 0) {
        onUpdate(reformat_date_cumdays(formattedData))
      }
    } while (hasNextPage)

    if (onUpdate) onUpdate(reformat_date_cumdays(formattedData))
    if (onFinish) onFinish({
      total: totalToFetch,
      maxIncrement,
      createdAt: since,
    })

    return reformat_date_cumdays(formattedData)
  }

  /**
   * fetch release data
   * @param owner owner of the repository
   * @param name name of the repository
   * @param onUpdate (data) function that will be called when a new data update is avaiable
   * @param onFinish (stats) function that will be called when fetching is finished
   * @param onProgress (progress) function that will be called when progress is updated
   * @param shouldAbort function that returns a boolean which determines whether fetching should abort
   * @returns Object that contains statistics
   */
  fetchReleaseData = async (owner, name, onUpdate, onFinish, onProgress, shouldAbort) => {
    const variables = {
      owner: owner,
      name: name,
    }

    // define the graphql query
    const query = /* GraphQL */ `
      query getRelease($owner: String!, $name: String!){
        repository(owner: $owner, name: $name) {
          releases(first: 1, orderBy:{field:CREATED_AT,direction: DESC}) {
            totalCount
            nodes {
              name
              tagName
              createdAt
              releaseAssets (first: 20) {
                totalCount
                nodes {
                  id
                  name
                  updatedAt
                  contentType
                  createdAt
                  downloadCount
                  
                }
              }
            }
          }
        }
      }
    `

    // local variables
    const formattedData = []
    let totalToFetch = 0
    let numberFetched = 0
    let totalDownloads = 0

    // Preparation query
    const data = await this.gqlClient.request(query, variables)
    // if (shouldAbort) {
    //   if (shouldAbort()) {
    //     return
    //   }
    // }

    if (data.repository.releases.totalCount !== 0) {
      // from preparation
      totalToFetch = data.repository.releases.nodes[0].releaseAssets.totalCount

      // get stats of each asset
      data.repository.releases.nodes[0].releaseAssets.nodes.forEach(asset => {
        formattedData.push({
          id: asset.id,
          name: asset.name,
          updatedAt: asset.updatedAt,
          contentType: asset.contentType,
          createdAt: asset.createdAt,
          downloadCount: asset.downloadCount,
        })

        totalDownloads += asset.downloadCount

        numberFetched += 1
        if (onProgress) onProgress(getProgress(numberFetched, totalToFetch))
      })

      if (onProgress) onProgress(100)

      if (onUpdate) onUpdate(formattedData)

      if (onFinish) onFinish({
        totalAssets: totalToFetch,
        totalDownloads: totalDownloads,
        name: data.repository.releases.nodes[0].name,
        tagName: data.repository.releases.nodes[0].tagName,
        createdAt: data.repository.releases.nodes[0].createdAt
      })
    } else {
      if (onProgress) onProgress(100)

      if (onUpdate) onUpdate(formattedData)

      if (onFinish) onFinish({
        totalAssets: totalToFetch,
        totalDownloads: totalDownloads,
      })
    }

    return formattedData
  }
}

export default GithubFetcher