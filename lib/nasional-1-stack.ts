import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigateway2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

export class Nasional1Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // IAM Role
    const lksrole = new iam.Role(this, 'lks-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // S3 Bucket
    const paymentBucket = new s3.Bucket(this, 'lks-ilmi-payment-bucket', {
      bucketName: 'lks-ilmi-payment-bucket',
    });

    // VPC
    const lksvpc = new ec2.Vpc(this, 'lks-vpc', {
      ipAddresses: ec2.IpAddresses.cidr('172.32.0.0/16'),
      availabilityZones: ['ap-southeast-1a', 'ap-southeast-1b'],
      natGateways: 1,
    });

    // Security Group
    const lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      'lambda-internet-sg',
      {
        vpc: lksvpc,
        allowAllOutbound: true,
        securityGroupName: 'lambda-internet-sg',
        description: 'Allowing Lambda Access From The Internet',
      }
    );
    lambdaSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow inbound HTTP traffic'
    );
    lambdaSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow inbound HTTP traffic'
    );

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'rds-sg', {
      vpc: lksvpc,
      allowAllOutbound: true,
      securityGroupName: 'rds-sg',
      description: 'Allowing RDS Access From The Internet',
    });
    rdsSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow inbound HTTP traffic'
    );

    // SQS
    const orderQueue = new sqs.Queue(this, 'lks-queue-order.fifo', {
      queueName: 'lks-queue-order.fifo',
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      maxMessageSizeBytes: 256000,
      contentBasedDeduplication: true,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'lks-queue-order-dlq.fifo', {
          queueName: 'lks-queue-order-dlq.fifo',
          fifo: true,
          visibilityTimeout: cdk.Duration.seconds(30),
          maxMessageSizeBytes: 256000,
          contentBasedDeduplication: true,
          retentionPeriod: cdk.Duration.days(4),
        }),
      },
    });

    const paymentQueue = new sqs.Queue(this, 'lks-queue-payment.fifo', {
      queueName: 'lks-queue-payment.fifo',
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      maxMessageSizeBytes: 256000,
      contentBasedDeduplication: true,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'lks-queue-payment-dlq.fifo', {
          queueName: 'lks-queue-payment-dlq.fifo',
          fifo: true,
          visibilityTimeout: cdk.Duration.seconds(30),
          maxMessageSizeBytes: 256000,
          contentBasedDeduplication: true,
          retentionPeriod: cdk.Duration.days(4),
        }),
      },
    });

    // DynamoDB
    const tokenstable = new dynamodb.TableV2(this, 'tokens', {
      tableName: 'tokens',
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.provisioned({
        readCapacity: dynamodb.Capacity.autoscaled({
          minCapacity: 10,
          maxCapacity: 100,
          targetUtilizationPercent: 70,
        }),
        writeCapacity: dynamodb.Capacity.autoscaled({
          minCapacity: 5,
          maxCapacity: 25,
          targetUtilizationPercent: 70,
        }),
      }),
    });

    const websocketcontable = new dynamodb.TableV2(this, 'websocketcontable', {
      tableName: 'wsConnection',
      partitionKey: {
        name: 'connectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billing: dynamodb.Billing.onDemand(),
    });

    // RDS
    const postgrescluster = new rds.DatabaseCluster(
      this,
      'lks-postgres-cluster',
      {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_1,
        }),
        writer: rds.ClusterInstance.serverlessV2('writer'),
        credentials: rds.Credentials.fromUsername('postgreslks', {
          password: cdk.SecretValue.unsafePlainText('Skills53'),
        }),
        serverlessV2MinCapacity: 0.5,
        serverlessV2MaxCapacity: 1.0,
        enableDataApi: true,
        defaultDatabaseName: 'lksdb',
        deletionProtection: false,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [rdsSecurityGroup],
        vpc: lksvpc,
      }
    );

    // RDS Parameters
    const dbkeydir = '/lks/database/';
    const dbname = new ssm.StringParameter(this, 'DBName-Parameter', {
      parameterName: dbkeydir + 'dbname',
      stringValue: 'lksdb',
    });

    const dbusername = new ssm.StringParameter(this, 'DBUsername-Parameter', {
      parameterName: dbkeydir + 'username',
      stringValue: 'postgreslks',
    });

    const dbendpoint = new ssm.StringParameter(this, 'DBEndpoint-Parameter', {
      parameterName: dbkeydir + 'endpoint',
      stringValue: postgrescluster.clusterEndpoint.hostname,
    });

    // Lambda Layer
    const lksLayer: lambda.ILayerVersion = new lambda.LayerVersion(
      this,
      'lks-lambdaLayer',
      {
        code: lambda.Code.fromAsset('resources/services/layer/'),
        compatibleRuntimes: [
          lambda.Runtime.NODEJS_16_X,
          lambda.Runtime.NODEJS_18_X,
          lambda.Runtime.NODEJS_20_X,
          lambda.Runtime.NODEJS_LATEST,
        ],
        description: 'LKS Lambda Layer',
        license: 'MIT',
        layerVersionName: 'lks-lambdaLayer',
      }
    );

    const lksLayers: lambda.ILayerVersion[] = [lksLayer];

    // REST API
    const lksapigw = new apigateway.RestApi(this, 'lks-api-gw', {
      restApiName: 'lks-api-gw',
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
      description: 'LKS API Gateway',
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          '*',
          'Deviceid',
          'deviceid',
          'deviceId',
          'Authorization',
          'authorization',
        ],
      },
      deployOptions: {
        stageName: 'prod',
      },
    });

    // LKS Role Policies
    const ssmReadParameterPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameters'],
      resources: ['*'],
    });

    const ec2PolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeNetworkInterfaces',
        'ec2:CreateNetworkInterface',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    });

    const cloudwatchPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: ['*'],
    });

    orderQueue.grantConsumeMessages(lksrole);
    orderQueue.grantSendMessages(lksrole);
    paymentQueue.grantConsumeMessages(lksrole);
    paymentQueue.grantSendMessages(lksrole);
    tokenstable.grantReadWriteData(lksrole);
    websocketcontable.grantReadWriteData(lksrole);
    lksrole.addToPolicy(ssmReadParameterPolicy);
    lksrole.addToPolicy(ec2PolicyStatement);
    lksrole.addToPolicy(cloudwatchPolicyStatement);

    // WEBSOCKET API
    const lkswebsocket = new lambda.Function(this, 'lks-websocket', {
      functionName: 'lks-websocket',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      handler: 'websocket.handler',
      code: lambda.Code.fromAsset('resources/services/src'),
      memorySize: 256,
      layers: lksLayers,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lkswebsocketapi = new apigateway2.WebSocketApi(this, 'lks-wsapi-gw', {
      apiName: 'lks-wsapi-gw',
      description: 'LKS Websocket API Gateway',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          'ConnectIntergation',
          lkswebsocket
        ),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          'DisconnectIntergation',
          lkswebsocket
        ),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          'DefaultIntergation',
          lkswebsocket
        ),
      },
      routeSelectionExpression: '$request.body.action',
    });
    lkswebsocketapi.addRoute('sendMessage', {
      integration: new WebSocketLambdaIntegration(
        'sendMessageIntegration',
        lkswebsocket
      ),
    });
    lkswebsocketapi.addRoute('getConnectionId', {
      integration: new WebSocketLambdaIntegration(
        'getConnectionIdIntegration',
        lkswebsocket
      ),
    });
    lkswebsocketapi.addRoute('broadcastMessage', {
      integration: new WebSocketLambdaIntegration(
        'broadcastMessageIntegration',
        lkswebsocket
      ),
    });

    new apigateway2.WebSocketStage(this, 'prod', {
      stageName: 'prod',
      webSocketApi: lkswebsocketapi,
      autoDeploy: true,
    });

    // Lambda
    const backenddir = 'resources/services/src';
    const lksauth = new lambda.Function(this, 'lks-auth', {
      functionName: 'lks-auth',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'auth.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(3),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lkstoken = new lambda.Function(this, 'lks-token', {
      functionName: 'lks-token',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'token.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lksReadEvent = new lambda.Function(this, 'lks-read-event', {
      functionName: 'lks-read-event',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'eventRead.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lksWriteEvent = new lambda.Function(this, 'lks-write-event', {
      functionName: 'lks-write-event',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'eventWrite.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lksTicket = new lambda.Function(this, 'lks-ticket', {
      functionName: 'lks-ticket',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'ticket.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lksReadOrder = new lambda.Function(this, 'lks-read-order', {
      functionName: 'lks-read-order',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'orderRead.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
    });

    const lksWriteOrder = new lambda.Function(this, 'lks-write-order', {
      functionName: 'lks-write-order',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'orderWrite.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
      environment: {
        SQS_QUEUE_URL: orderQueue.queueUrl,
        WEBSOCKET_ID: lkswebsocketapi.apiId,
      },
    });
    lksWriteOrder.addEventSource(
      new eventsources.SqsEventSource(orderQueue, {
        batchSize: 1,
      })
    );

    const lksQueueOrder = new lambda.Function(this, 'lks-queue-order', {
      functionName: 'lks-queue-order',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'orderQueue.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
      environment: {
        SQS_QUEUE_URL: orderQueue.queueUrl,
      },
    });

    const lksQueuePayment = new lambda.Function(this, 'lks-queue-payment', {
      functionName: 'lks-queue-payment',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'paymentQueue.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
      environment: {
        SQS_QUEUE_URL: paymentQueue.queueUrl,
      },
    });
    lksQueuePayment.addEventSource(
      new eventsources.S3EventSource(paymentBucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: '[proofOfPayment]/' }],
      })
    );

    const lksPayment = new lambda.Function(this, 'lks-payment', {
      functionName: 'lks-payment',
      runtime: lambda.Runtime.NODEJS_16_X,
      role: lksrole,
      layers: lksLayers,
      handler: 'payment.handler',
      code: lambda.Code.fromAsset(backenddir),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: lksvpc,
      securityGroups: [lambdaSecurityGroup],
      environment: {
        SQS_QUEUE_URL: paymentQueue.queueUrl,
      },
    });
    lksPayment.addEventSource(
      new eventsources.SqsEventSource(paymentQueue, {
        batchSize: 1,
      })
    );

    const lambdaAuthorizer = new apigateway.RequestAuthorizer(
      this,
      'lks-authorizer',
      {
        handler: lksauth,
        resultsCacheTtl: cdk.Duration.seconds(0),
        identitySources: [
          apigateway.IdentitySource.header('Authorization'),
          apigateway.IdentitySource.header('Deviceid'),
        ],
      }
    );

    const s3PutItemRole = new iam.Role(this, 's3PutItemRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        s3putitempolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:PutObject'],
              resources: [paymentBucket.bucketArn + '/*'],
            }),
          ],
        }),
      },
    });

    const s3Integration = new apigateway.AwsIntegration({
      service: 's3',
      path: `${paymentBucket.bucketName}/proofOfPayment/{filename}`,
      integrationHttpMethod: 'PUT',
      options: {
        credentialsRole: s3PutItemRole,
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestParameters: {
          ['integration.request.path.filename']: 'method.request.path.filename', // Make Sure The String Is Single Quote
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '',
            },
          },
        ],
      },
    });

    // Main API Gateway

    // Payment Route
    const payment = lksapigw.root.addResource('payment');
    const payments3 = payment.addResource('{filename}');
    payments3.addMethod('PUT', s3Integration, {
      authorizer: lambdaAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
      requestParameters: {
        'method.request.path.filename': true,
      },
    });

    // Token Route
    const token = lksapigw.root.addResource('token');
    token.addMethod('POST', new apigateway.LambdaIntegration(lkstoken), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });

    // Event Route
    const event = lksapigw.root.addResource('event');

    const writeEventIntegration = new apigateway.LambdaIntegration(
      lksWriteEvent
    );
    const readEventIntegration = new apigateway.LambdaIntegration(lksReadEvent);
    event.addMethod('POST', writeEventIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    event.addMethod('GET', readEventIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Event By Id
    const eventById = event.addResource('{id}');
    eventById.addMethod('GET', readEventIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      requestParameters: {
        'method.request.path.id': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
    eventById.addMethod('PUT', writeEventIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
    eventById.addMethod('DELETE', writeEventIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Order Route
    const order = lksapigw.root.addResource('order');
    order.addMethod('POST', new apigateway.LambdaIntegration(lksQueueOrder), {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
    order.addMethod('GET', new apigateway.LambdaIntegration(lksReadOrder), {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Ticket Route
    const ticket = lksapigw.root.addResource('ticket');
    const writeTicketIntegration = new apigateway.LambdaIntegration(lksTicket);
    ticket.addMethod('POST', writeTicketIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
    const ticketById = ticket.addResource('{id}');

    ticketById.addMethod('DELETE', writeTicketIntegration, {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer: lambdaAuthorizer,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
  }
}
