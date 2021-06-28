import * as cdk from "@aws-cdk/core";
import * as CodeBuild from "@aws-cdk/aws-codebuild";
import * as S3 from "@aws-cdk/aws-s3";
import * as CodePipeline from "@aws-cdk/aws-codepipeline";
import * as CodePipelineAction from "@aws-cdk/aws-codepipeline-actions";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import * as origins from "@aws-cdk/aws-cloudfront-origins";
import * as iam from "@aws-cdk/aws-iam";

export class EdaTodoFrontendPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    // Amazon S3 bucket to store CRA website
    const bucketWebsite = new S3.Bucket(this, `${id}_website_bucket`, {
      bucketName: `${id}-website-bucket`.toLocaleLowerCase(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "error.html",
      publicReadAccess: true,
    });

    const dist = new cloudfront.Distribution(
      this,
      `${id}_cloudfront_dist_for_website_bucket`,
      {
        defaultBehavior: {
          origin: new origins.S3Origin(bucketWebsite),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      }
    );

    // AWS CodeBuild artifacts
    const outputSources = new CodePipeline.Artifact();
    const outputWebsite = new CodePipeline.Artifact();

    // AWS CodePipeline pipeline
    const pipeline = new CodePipeline.Pipeline(this, `${id}_pipeline`, {
      pipelineName: `${id}_pipeline`,
      crossAccountKeys: false, //Pipeline construct creates an AWS Key Management Service (AWS KMS) which cost $1/month. this will save your $1.
      restartExecutionOnUpdate: true, //Indicates whether to rerun the AWS CodePipeline pipeline after you update it.
    });

    // AWS CodePipeline stage to clone sources from GitHub repository
    pipeline.addStage({
      stageName: "Source",
      actions: [
        new CodePipelineAction.GitHubSourceAction({
          actionName: "Checkout",
          owner: "nabeelfarid",
          repo: "eda-todo-frontend",
          oauthToken: cdk.SecretValue.secretsManager("GITHUB_TOKEN_FOR_AWS"), ///create token on github and save it on aws secret manager
          output: outputSources,
          branch: "master",
        }),
      ],
    });

    // AWS CodePipeline stage to build CRA website and CDK resources
    pipeline.addStage({
      stageName: "Build",
      actions: [
        // AWS CodePipeline action to run CodeBuild project
        new CodePipelineAction.CodeBuildAction({
          actionName: "Build-Gatsby-Website",
          project: new CodeBuild.PipelineProject(
            this,
            `${id}_codebuild_project_build_website`,
            {
              projectName: `${id}_codebuild_project_build_website`,
              buildSpec: CodeBuild.BuildSpec.fromObject({
                version: "0.2",
                phases: {
                  install: {
                    "runtime-versions": {
                      nodejs: "latest",
                    },
                    commands: [
                      "npm update -g",
                      "npm install -g gatsby-cli",
                      "npm install -g yarn",
                      "yarn",
                    ],
                  },
                  build: {
                    commands: ["gatsby build"],
                  },
                },
                artifacts: {
                  "base-directory":
                    // "./stepxx_CI_CD_pipeline_update_frontend/frontend/public", ///outputting our generated Gatsby Build files to the public directory
                    "./public", ///outputting our generated Gatsby Build files to the public directory
                  files: ["**/*"],
                },
              }),
              environment: {
                buildImage: CodeBuild.LinuxBuildImage.STANDARD_5_0, ///BuildImage version 3 because we are using nodejs environment 12
              },
            }
          ),
          input: outputSources,
          outputs: [outputWebsite],
        }),
      ],
    });

    // AWS CodePipeline stage to deployt CRA website and CDK resources
    pipeline.addStage({
      stageName: "Deploy",
      actions: [
        // AWS CodePipeline action to deploy CRA website to S3
        new CodePipelineAction.S3DeployAction({
          actionName: "DeployWebsite",
          input: outputWebsite,
          bucket: bucketWebsite,
          runOrder: 1,
        }),
      ],
    });

    // Create the build project that will invalidate the cloudfornt cache after deployment to S3 Bucket
    // https://github.com/aws/aws-cdk/issues/6243
    // https://github.com/aws/aws-cdk/blob/20a2820ee4d022663fcd0928fbc0f61153ae953f/packages/@aws-cdk/aws-codepipeline-actions/README.md#invalidating-the-cloudfront-cache-when-deploying-to-s3
    const invalidateBuildProject = new CodeBuild.PipelineProject(
      this,
      `${id}_codebuild_project_cloudfront_cache_invalidation`,
      {
        projectName: `${id}_codebuild_project_cloudfront_cache_invalidation`,
        buildSpec: CodeBuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            build: {
              commands: [
                'aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths "/*"',
                // Choose whatever files or paths you'd like, or all files as specified here
              ],
            },
          },
        }),
        environmentVariables: {
          CLOUDFRONT_ID: { value: dist.distributionId },
        },
      }
    );

    // iam policy to invalidate cloudfront distribution's cache
    // https://dev.to/ryands17/deploying-a-spa-using-aws-cdk-typescript-4ibf
    invalidateBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetDistribution*",
          "cloudfront:GetInvalidation",
          "cloudfront:ListInvalidations",
          "cloudfront:ListDistributions",
        ],
      })
    );

    // AWS CodePipeline stage to deploy website and CDK resources
    pipeline.addStage({
      stageName: "CacheInvalidation",
      actions: [
        new CodePipelineAction.CodeBuildAction({
          actionName: "Invalidate-Cache",
          project: invalidateBuildProject,
          input: outputWebsite,
          runOrder: 1,
        }),
      ],
    });

    new cdk.CfnOutput(this, "BucketWebsiteURL", {
      value: bucketWebsite.bucketWebsiteUrl,
      description: "Bucket Website URL",
    });

    new cdk.CfnOutput(this, "CloudFrontURL", {
      value: dist.domainName,
      description: "CloudFront URL",
    });
  }
}
