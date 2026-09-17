// Jenkins Pipeline for Codeforge.ai — see docs/DEPLOYMENT.md for the
// architecture this automates (Option A: a single host, two systemd-managed
// processes — API + worker — behind Caddy/Nginx).
// This does NOT touch, and is unrelated to, the DeploymentAdapter interface
// a *connected project* may configure for its own Jenkins deployments (see
// docs/MVP_SCOPE.md) — this pipeline builds/deploys the platform itself.
//
// Stages mirror .github/workflows/ci.yml (typecheck, test, build, smoke-test
// the compiled build) for every branch/PR, then adds a deploy stage that
// only runs on `main` — the exact same steps documented in
// docs/DEPLOYMENT.md "Redeploying a new version", run over SSH.
//
// Required Jenkins setup (do this once, in the Jenkins UI):
//   - Plugins: "Pipeline", "SSH Agent", "NodeJS" (or Node 22.9+ already on
//     every agent's PATH).
//   - Credentials: an SSH private-key credential (id: "codeforge-deploy-ssh")
//     whose public half is authorized on the production host for the
//     `codeforge` service account (deploy user). This pipeline runs `git
//     pull`/`npm run build`/`systemctl restart` as that user over SSH; it
//     never reads or embeds any application secret (CREDENTIAL_ENCRYPTION_KEY
//     etc.) itself — those already live only in /etc/codeforge/*.env on
//     the host, per docs/DEPLOYMENT.md "Secrets configuration".
//   - A multibranch pipeline or a single pipeline job pointed at this
//     Jenkinsfile, with a GitHub webhook (or polling) triggering it on push.

pipeline {
  agent any

  options {
    timestamps()
    // Mirrors .github/workflows/ci.yml's concurrency group — a new commit on
    // the same branch supersedes a still-running build for it.
    disableConcurrentBuilds()
    timeout(time: 30, unit: 'MINUTES')
  }

  tools {
    // Requires the "NodeJS" plugin with a tool named "node22" configured
    // under Manage Jenkins -> Tools (Node 22.9+, matching docs/DEPLOYMENT.md).
    // If your agents already have a suitable Node on PATH, delete this block.
    nodejs 'node22'
  }

  parameters {
    // Lets an operator trigger a rollback build by re-running this pipeline
    // against a previous commit/tag without reverting `main` first.
    string(name: 'DEPLOY_REF', defaultValue: '', description: 'Optional: a specific commit SHA or tag to deploy instead of the triggering commit (rollback).')
  }

  environment {
    DEPLOY_HOST = 'codeforge.ai'                // production host or IP
    DEPLOY_USER = 'codeforge'                   // service account
    DEPLOY_PATH = '/opt/codeforge'              // app directory on host
    SSH_CREDENTIALS_ID = 'codeforge-deploy-ssh'
  }

  stages {

    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Backend: typecheck, test, build') {
      steps {
        sh 'npm ci'
        sh 'npm run typecheck'
        sh 'npm test'
        // Also verifies the .sql migrations get packaged into dist/ — see
        // docs/DEPLOYMENT.md "Database migrations".
        sh 'npm run build'
      }
    }

    stage('Backend: smoke-test compiled build') {
      // Same check CI already does — boots the actual compiled artifact
      // (never `tsx`) with no credentials, confirms it starts cleanly and
      // shuts down cleanly on SIGTERM. Catches the class of bug that only
      // typechecking/unit tests can't: a `dist/` that doesn't actually boot.
      steps {
        sh '''
          set -e
          rm -rf /tmp/jenkins-smoke && mkdir -p /tmp/jenkins-smoke
          DB_PATH=/tmp/jenkins-smoke/platform.sqlite \
          WORKSPACES_ROOT=/tmp/jenkins-smoke/workspaces \
          CODING_ENGINE=opencode \
          NODE_ENV=production \
          PORT=3999 \
            node dist/src/api/server.js &
          SERVER_PID=$!

          for i in $(seq 1 20); do
            if curl -sf http://localhost:3999/health > /dev/null; then break; fi
            sleep 0.5
          done
          curl -sf http://localhost:3999/health
          curl -sf http://localhost:3999/health/ready

          kill -TERM $SERVER_PID
          wait $SERVER_PID
          echo "server exited cleanly on SIGTERM"
        '''
      }
    }

    stage('Frontend: typecheck, test, build') {
      steps {
        dir('web') {
          sh 'npm ci'
          sh 'npm run typecheck'
          sh 'npm run test'
          sh 'npm run build'
        }
      }
    }

    stage('Deploy to production') {
      // Only on main, and only after every check above passed — never
      // deploy an untested/unbuilt commit. Runs exactly the steps documented
      // in docs/DEPLOYMENT.md "Redeploying a new version", over SSH, as the
      // dedicated aitaskmanager service account (never root).
      when {
        allOf {
          branch 'main'
          expression { currentBuild.currentResult == 'SUCCESS' }
        }
      }
      steps {
        sshagent(credentials: [SSH_CREDENTIALS_ID]) {
          sh '''
            set -e
            REF="${DEPLOY_REF:-$GIT_COMMIT}"
            ssh -o StrictHostKeyChecking=accept-new ${DEPLOY_USER}@${DEPLOY_HOST} bash -se <<EOF
              set -e
              cd ${DEPLOY_PATH}
              git fetch --all --tags
              git checkout ${REF}
              npm ci && npm run build
              npm --prefix web ci && npm --prefix web run build
              exit
          EOF
            # systemctl restart needs root; the deploy user is granted a narrow,
            # passwordless sudo rule for exactly these two units (see the
            # accompanying chat message's sudoers snippet) rather than running
            # the whole deploy as root.
            ssh -o StrictHostKeyChecking=accept-new ${DEPLOY_USER}@${DEPLOY_HOST} \
              'sudo systemctl restart codeforge-api codeforge-worker'
          '''
        }
      }
    }

    stage('Verify deployment') {
      when {
        branch 'main'
      }
      steps {
        sh '''
          set -e
          for i in $(seq 1 20); do
            if curl -sf https://${DEPLOY_HOST}/api/health/ready > /dev/null; then break; fi
            sleep 1
          done
          echo "-- /api/health/ready --"
          curl -sf https://${DEPLOY_HOST}/api/health/ready
          echo
        '''
      }
    }
  }

  post {
    always {
      // Backend test runner and Vitest both support JUnit-style output if
      // you later want Jenkins's Test Result Trend graph — not wired in by
      // default here since neither repo package currently emits JUnit XML;
      // add a reporter (e.g. vitest's `--reporter=junit`) and a
      // `junit 'web/junit.xml'` step here if you want that later.
      cleanWs()
    }
    failure {
      echo 'Build/deploy failed — see the failed stage above. Production was left untouched unless the "Deploy to production" stage itself started (systemctl restart is the point of no return; see docs/DEPLOYMENT.md "Rollback" to recover).'
    }
  }
}
