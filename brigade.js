'use strict';

const { events, Job, Group } = require('brigadier');

const _hubCredentials = secrets => `
cat << EOF > $HOME/.config/hub
github.com:
  - protocol: https
    user: ${secrets.GITHUB_USERNAME}
    oauth_token: ${secrets.GITHUB_TOKEN}
EOF
`;

const _hubConfig = (email, name) => `
hub config --global credential.https://github.com.helper /usr/local/bin/hub-credential-helper
hub config --global hub.protocol https
hub config --global user.email "${email}"
hub config --global user.name "${name}"
`;

const _commitImage = (image, buildID) => `
cat << EOF > patch.yaml
spec:
  template:
    spec:
      containers:
        - name: gitops-hello-world-brigade
          image: ${image}
EOF

kubectl patch --local -o yaml \
  -f kubernetes/deployment.yaml \
  -p "$(cat patch.yaml)" \
  > deployment.yaml

mv deployment.yaml kubernetes/deployment.yaml

hub add kubernetes/deployment.yaml

hub commit -F- << EOF
Update hello world REST API

This commit updates the deployment container image to:
  ${image}

Build ID:
  ${buildID}
EOF
`;

const _pushCommit = cloneURL => `
hub remote add origin ${cloneURL}

hub push origin master
`;

events.on('gcr_image_push', async (brigadeEvent, project) => {
  console.log('[EVENT] "gcr_image_push" - build ID: ', brigadeEvent.buildID);

  const payload = JSON.parse(brigadeEvent.payload);
  const imageAction = payload.imageData.action; // "INSERT" or "DELETE"
  const image = payload.imageData.tag;

  console.log('image action: ', imageAction);
  console.log('image: ', image);

  const infraJob = new Job('update-infra-config');

  infraJob.storage.enabled = false;
  infraJob.image = 'gcr.io/hightowerlabs/hub';
  infraJob.tasks = [
    _hubCredentials(project.secrets),
    _hubConfig('gitops-bot@crowdynews.com', 'GitOps Bot'),
    'cd src',
    _commitImage(image, brigadeEvent.buildID),
    _pushCommit(project.repo.cloneURL)
  ];

  await infraJob.run();

  const buildID = brigadeEvent.buildID;
  const kashtiURL = `${project.secrets.KASHTI_URL}/#!/build/${buildID}`;
  const projectName = project.name;
  const slackJob = new Job('slack-notify-update-infra');

  slackJob.storage.enabled = false;
  slackJob.image = 'technosophos/slack-notify';
  slackJob.tasks = ['/slack-notify'];
  slackJob.env = {
    SLACK_WEBHOOK: project.secrets.SLACK_WEBHOOK,
    SLACK_TITLE: 'Infra Config Update',
    SLACK_MESSAGE: `Project <${projectName}|${projectName}>\nDocker image <http://${image}|${image}>\nBrigade build <${kashtiURL}|${buildID}>`,
    SLACK_COLOR: '#82aaff'
  };

  slackJob.run();
});

events.on('push', async (brigadeEvent, project) => {
  console.log('[EVENT] "push" - brigade event: ', brigadeEvent);

  const deployJob = new Job('deploy-to-staging');

  deployJob.storage.enabled = false;
  deployJob.image = 'gcr.io/cloud-builders/kubectl';
  deployJob.tasks = ['cd src', 'kubectl apply --recursive -f kubernetes'];

  await deployJob.run();

  const projectName = project.name;
  const commitSHA = brigadeEvent.revision.commit;
  const shortCommitSHA = commitSHA.substr(0, 7);
  const commitURL = `${projectName}/commit/${commitSHA}`;
  const buildID = brigadeEvent.buildID;
  const kashtiURL = `${project.secrets.KASHTI_URL}/#!/build/${buildID}`;
  const slackJob = new Job('slack-notify-deploy-staging');

  slackJob.storage.enabled = false;
  slackJob.image = 'technosophos/slack-notify';
  slackJob.tasks = ['/slack-notify'];
  slackJob.env = {
    SLACK_WEBHOOK: project.secrets.SLACK_WEBHOOK,
    SLACK_TITLE: 'Deploy to Staging',
    SLACK_MESSAGE: `Project <${projectName}|${projectName}>\nCommit <${commitURL}|${shortCommitSHA}>\nBrigade build <${kashtiURL}|${buildID}>`,
    SLACK_COLOR: '#c792ea'
  };

  await slackJob.run();
});

events.on('error', (brigadeEvent, project) => {
  console.log('[EVENT] "error" - brigade event: ', brigadeEvent);
});
