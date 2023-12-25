import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import axios, { AxiosRequestConfig } from 'axios'
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

    const uploader = async (path: string, bf: ArrayBuffer) => {
      await axios.put(basePath + path, bf, {
        auth: {
          username: 'actions',
          password: token
        }
      })
    }

    let uploadAmount = 0
    for (const file of toUpload) {
      await uploader(file.name, await file.async('arraybuffer'))
      console.log(`Uploaded ${file.name}`)
      uploadAmount++

      if (file.name.endsWith('maven-metadata.xml')) {
        const metadata = new XMLParser().parse(
          await file.async('string')
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
    console.log()

    console.log(`Published artifacts:`)
    artifacts.forEach(art =>
      console.log(`\t${art.group}:${art.name}:${art.version}`)
    )

    if (prNumber == 0) return
    const pr = await octo.rest.pulls.get({
      ...context.repo,
      pull_number: prNumber
    })

    if (pr.data.state != 'open') return

    let repoBlock: string
    let comment = await generateComment(
      octo,
      prNumber,
      artifacts,
      rb => (repoBlock = rb)
    )
    const self = getInput('self-name')

    let selfCommentId = null
    for await (const comments of octo.paginate.iterator(
      octo.rest.issues.listComments,
      {
        ...context.repo,
        issue_number: prNumber
      }
    )) {
      for (const comment of comments.data) {
        if (comment.user!.login == self) {
          selfCommentId = comment.id
        }
      }
    }

    if (context.repo.repo.toLowerCase() == 'neoforge') {
      const neoArtifact = artifacts.find(
        art => art.group == 'net.neoforged' && art.name == 'neoforge'
      )
      if (neoArtifact != null) {
        comment += await generateMDK(
          uploader,
          prNumber,
          neoArtifact,
          repoBlock!
        )
      }
    }

    if (selfCommentId) {
      await octo.rest.issues.updateComment({
        ...context.repo,
        comment_id: selfCommentId,
        body: comment
      })
    } else {
      await octo.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body: comment
      })
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      console.log(`Error: ${error.message}`)
      console.log(error.stack)
      core.setFailed(error.message)
    }
  }
}

async function generateComment(
  octo: InstanceType<typeof GitHub>,
  prNumber: number,
  artifacts: PublishedArtifact[],
  repoBlock: (block: string) => void
): Promise<string> {
  let comment = `## PR Publishing  \n### The artifacts published by this PR:  `
  for (const artifactName of artifacts) {
    const artifact = await octo.rest.packages.getPackageForOrganization({
      org: context.repo.owner,
      package_type: 'maven',
      package_name: `pr${prNumber}.${artifactName.group}.${artifactName.name}`
    })

    comment += `\n- :package: [\`${artifactName.group}:${artifactName.name}:${artifactName.version}\`](${artifact.data.html_url})`
  }
  comment += `  \n\n### Repository Declaration:\n`
  const includeModules = artifacts
    .map(art => `includeModule('${art.group}', '${art.name}')`)
    .map(a => `            ${a}`) // Indent
    .join('\n')
  const repoBlockStr = `
\`\`\`gradle
repositories {
    maven {
        name 'Maven for PR #${prNumber}'
        url 'https://prmaven.neoforged.net/${context.repo.repo}/pr${prNumber}'
        content {
${includeModules}
        }
    }
}
\`\`\``
  comment += repoBlockStr
  repoBlock(repoBlockStr)
  return comment
}

// NeoForge repo specific
async function generateMDK(
  uploader: (path: string, bf: ArrayBuffer) => Promise<void>,
  prNumber: number,
  artifact: PublishedArtifact,
  repoBlock: string
): Promise<string> {
  const versions = artifact.version.split('.')
  const mcVersion = `1.${versions[0]}.${versions[1]}`

  const config = {
    responseType: 'arraybuffer'
  } as AxiosRequestConfig
  let response = await axios
    .get(`https://github.com/neoforged/mdk/zipball/${mcVersion}`, config)
    .catch(_ =>
      axios.get('https://github.com/neoforged/mdk/zipball/main', config)
    )
  if (response.status != 200) {
    response = await axios.get(
      'https://github.com/neoforged/mdk/zipball/main',
      config
    )
  }

  let zip = await JSZip.loadAsync(response.data)
  // Find first root folder
  zip = zip.folder(zip.filter((_, f) => f.dir)[0].name)!

  const gradleProperties = (
    await zip.file('gradle.properties')!.async('string')
  ).split('\n')
  const neoVersionIndex = gradleProperties.findIndex(value =>
    value.startsWith('neo_version=')
  )
  gradleProperties[neoVersionIndex] = `neo_version=${artifact.version}`

  const mcVersionIndex = gradleProperties.findIndex(value =>
    value.startsWith('minecraft_version=')
  )
  gradleProperties[mcVersionIndex] = `minecraft_version=${mcVersion}`

  zip.file('gradle.properties', gradleProperties.join('\n'))

  let buildGradle = await zip.file('build.gradle')!.async('string')
  buildGradle += `\n${repoBlock}`

  zip.file('build.gradle', buildGradle)

  const path = `${artifact.group}/${artifact.name}/${artifact.version}/mdk-pr${prNumber}.zip`
  await uploader(
    path,
    await zip.generateAsync({
      type: 'arraybuffer'
    })
  )

  return `
### MDK installation
\`\`\`bash
mkdir ${context.repo.repo}-pr${prNumber}
cd ${context.repo.repo}-pr${prNumber}
curl https://prmaven.neoforged.net/${context.repo.repo}/pr${prNumber}/${path} -o mdk.zip
jar xf mdk.zip
\`\`\`

[Installer link](https://prmaven.neoforged.net/${context.repo.repo}/pr${prNumber}/${artifact.group}/${artifact.name}/${artifact.version}/${artifact.name}-${artifact.version}-installer.jar)`
}

interface WorkflowRun {
  id: number
}

interface PublishedArtifact {
  group: string
  name: string
  version: string
}
