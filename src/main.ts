import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import axios from 'axios'
import JSZip from 'jszip'
import * as process from 'process'
import { getInput } from '@actions/core'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'

export async function run(): Promise<void> {
  try {
    const token = process.env['GITHUB_TOKEN']!

    const octo: InstanceType<typeof GitHub> = getOctokit(token)

    const workflow_run = context.payload.workflow_run as WorkflowRun

    const artifact = await octo.rest.actions
      .listWorkflowRunArtifacts({
        ...context.repo,
        run_id: workflow_run.id
      })
      .then(art => art.data.artifacts.find(ar => ar.name == 'maven-publish'))

    console.log(`Found artifact: ${artifact!.archive_download_url}`)

    const response = await axios.get(artifact!!.archive_download_url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    const zip = await JSZip.loadAsync(response.data)

    const payload = JSON.parse(await zip.file('event.json')!.async('string'))

    const prNumber = (payload.pull_request?.number ?? 0) as number

    console.log(`PR number: ${prNumber}`)

    const filter = getInput('artifacts_base_path')
    const toUpload = zip.filter((_relativePath, file) => {
      return (
        !file.dir && file.name != 'event.json' && file.name.startsWith(filter)
      )
    })

    const artifacts: PublishedArtifact[] = []
    const basePath = `https://maven.pkg.github.com/${context.repo.owner}/${context.repo.repo}/pr${prNumber}/`
    let uploadAmount = 0
    for (const file of toUpload) {
      await axios.put(basePath + file.name, await file.async('arraybuffer'), {
        auth: {
          username: 'actions',
          password: token
        }
      })
      console.log(`Uploaded ${file.name}`)
      uploadAmount++

      if (file.name.endsWith('maven-metadata.xml')) {
        const metadata = new XMLBuilder().build(
          new XMLParser().parse(await file.async('string'))
        ).metadata

        // Use the path as the artifact name and group just in case
        const split = file.name.split('/')
        split.pop()
        const name = split.pop()
        artifacts.push({
          group: split.join('.'),
          name: name!,
          version: metadata.versioning.latest
        })
      }
    }

    console.log(`Finished uploading ${uploadAmount} items`)
    console.log(`Published artifacts:`)
    artifacts.forEach(art =>
      console.log(`\t${art.group}:${art.name}:${art.version}`)
    )

    console.log(`Message:\n`)
    console.log(await generateComment(octo, prNumber, artifacts))

    if (prNumber == 0) return
    const pr = await octo.rest.pulls.get({
      ...context.repo,
      pull_number: prNumber
    })

    if (pr.data.state != 'open') return

    const self = await octo.rest.apps.getAuthenticated()

    let selfCommentId = null
    for await (const comments of octo.paginate.iterator(
      octo.rest.issues.listComments,
      {
        ...context.repo,
        issue_number: prNumber
      }
    )) {
      for (const comment of comments.data) {
        if (comment.user!.login == self.data.slug + '[bot]') {
          selfCommentId = comment.id
        }
      }
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function generateComment(
  octo: InstanceType<typeof GitHub>,
  prNumber: number,
  artifacts: PublishedArtifact[]
): Promise<string> {
  let comment = `# Published artifacts  \nThe artifacts published by this PR:  `
  for (const artifactName of artifacts) {
    const artifact = await octo.rest.packages.getPackageForOrganization({
      org: context.repo.owner,
      package_type: 'maven',
      package_name: `pr${prNumber}.${artifactName.group}.${artifactName.name}`
    })

    comment += `\n\t[\`${artifactName.group}:${artifactName.name}:${artifactName.version}\`](${artifact.data.html_url})`
  }
  return comment
}

interface WorkflowRun {
  id: number
}

interface PublishedArtifact {
  group: string
  name: string
  version: string
}
