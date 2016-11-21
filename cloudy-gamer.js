// TODO: support vpc machines too
// TODO: remove the requirement for us-west-2a
// TODO: validate that the volume is available
// TODO: respond to 1-minute-warning
// TODO: use a shared policy from my account (so everyone doesnt need it), maybe
//       security policy too

const ACCESS_KEY = "***REMOVED***"     // for ec2-gaming user
const SECRET_ACCESS_KEY = "***REMOVED***"
const REGION = "us-west-1"
const REGION_AND_ZONE = "us-west-1c"
const AMI = "ami-bfce84df"                    // for cloudygamer-loader5
const CLOUDYGAMER_VOLUME = "vol-4a07c0f5"     // for cloudygamer-win2016-110916 (or later) as gp2
const SECURITY_GROUP = "sg-4fa5f40a"
const SECURITY_GROUP_VPC = "sg-65c7dc01"
const SUBNET_ID_VPC = "subnet-a17abcf9"
const EXTRA_DOLLARS = 0.10
const TOO_EXPENSIVE = 1.50
const IAM_ROLE_NAME = "CloudyGamer_EC2_Role"  // has AmazonEC2RoleforSSM attached to it
const FULFILLMENT_TIMEOUT_MINUTES = 5
const AMI_USERNAME = "cloudygamer"

class CloudyGamer {
  constructor() {
    AWS.config.update({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_ACCESS_KEY,
      region: REGION
    })

    this.ec2 = new AWS.EC2()
    this.ssm = new AWS.SSM()

    this.ssm.api.waiters = {
      InstanceOnline: {
        name: "InstanceOnline",
        acceptors: [{
          argument: "InstanceInformationList[].PingStatus",
          expected: "Online",
          matcher: "pathAll",
          state: "success"
        }],
        delay: 5,
        maxAttempts: 80,
        operation: "describeInstanceInformation"
      }
    }
  }

  findLowestPrice() {
    const promises = []
    let histories = []

    console.log("Looking for lowest price...")
    for (const product of ['Linux/UNIX', 'Linux/UNIX (Amazon VPC)', 'Windows', 'Windows (Amazon VPC)']) {
      promises.push(this.ec2.describeSpotPriceHistory({
        AvailabilityZone: REGION_AND_ZONE,
        ProductDescriptions: [product],
        InstanceTypes: ["g2.2xlarge", "g2.8xlarge"],
        MaxResults: 100}).promise().then((data) => {
          histories = histories.concat(data.SpotPriceHistory)
        })
      )
    }

    return Promise.all(promises).then(() => {
      const zones = new Map()
      let lowest = histories[0]

      for (const price of histories) {
        const key = `${price.AvailabilityZone}-${price.InstanceType}-${price.ProductDescription}`

        if (!zones.get(key) || price.Timestamp > zones.get(key).Timestamp) {
          zones.set(key, price)
          if (parseFloat(price.SpotPrice) <= parseFloat(lowest.SpotPrice)) {
            lowest = price
          }
        }
      }

      console.log(`Found a ${lowest.InstanceType} on ${lowest.ProductDescription} at $${lowest.SpotPrice} in ${lowest.AvailabilityZone}`)

      if (Number(lowest.SpotPrice) >= TOO_EXPENSIVE) {
        throw new Error("Too expensive!")
      }

      return lowest
    })
  }

  startInstance() {
    return this.findLowestPrice().then(lowest => {
      console.log("Requesting spot instance...")
      const isVPC = lowest.ProductDescription.includes("VPC")

      return this.ec2.requestSpotInstances({
        SpotPrice: (Number(lowest.SpotPrice) + EXTRA_DOLLARS).toString(),
        ValidUntil: new Date((new Date()).getTime() + (60000 * FULFILLMENT_TIMEOUT_MINUTES)),
        Type: "one-time",
        LaunchSpecification: {
          ImageId: AMI,
          SecurityGroupIds: isVPC ? null : [SECURITY_GROUP],
          InstanceType: lowest.InstanceType,
          Placement: {
            AvailabilityZone: lowest.AvailabilityZone
          },
          EbsOptimized: lowest.InstanceType == "g2.2xlarge" ? true : null,
          NetworkInterfaces: !isVPC ? null : [{
            DeviceIndex: 0,
            SubnetId: SUBNET_ID_VPC,
            AssociatePublicIpAddress: true,
            Groups: [SECURITY_GROUP_VPC]
          }],
          IamInstanceProfile: {
            Name: IAM_ROLE_NAME
          }
        }
      }).promise().
      then(data => {
        return data.SpotInstanceRequests[0].SpotInstanceRequestId
      })

    }).
    then(spotId => {
      console.log("Waiting for instance to be fulfilled...")

      AWS.apiLoader.services.ec2["2015-10-01"].waiters.SpotInstanceRequestFulfilled.delay = 10
      return this.ec2.waitFor("spotInstanceRequestFulfilled", {
        SpotInstanceRequestIds: [spotId]}).promise().
      then(data => {
        const instanceId = data.SpotInstanceRequests[0].InstanceId

        return this.getInstance(instanceId).then(instance => {
          console.log(`Instance fulfilled (${instance.InstanceId}, ${instance.PublicIpAddress}). Waiting for running state...`)

          AWS.apiLoader.services.ec2["2015-10-01"].waiters.InstanceRunning.delay = 2
          return this.ec2.waitFor("instanceRunning", {
            InstanceIds: [instanceId]}).promise().
          then(_ => {          // might be broke?
            return instanceId
          })
        })
      })

    }).
    then(instanceId => {
      console.log("Attaching cloudygamer volume...")

      return this.ec2.attachVolume({
        VolumeId: CLOUDYGAMER_VOLUME,
        InstanceId: instanceId,
        Device: "/dev/xvdb"}).promise().
      then(_ => {
        return this.ec2.waitFor("volumeInUse", {
          VolumeIds: [CLOUDYGAMER_VOLUME],
          Filters: [{
            Name: "attachment.status",
            Values: ["attached"]
          }]}).promise()

      }).
      then(_ => {
        console.log("Waiting for instance to come online...")
        return this.ssm.waitFor("InstanceOnline", {
          InstanceInformationFilterList: [{
            key: "InstanceIds",
            valueSet: [instanceId]
          }]}).promise()
      })

    }).then(_ => {
      console.log("Ready!")

    }).catch(err => {
      console.error(err)
    })
  }

  stopInstance() {
    console.log("Retrieving instance id...")
    return this.getInstance().then(instance => {
      const instanceId = instance.InstanceId

      console.log("Terminating instance...")
      return this.ec2.terminateInstances({
        InstanceIds: [instanceId]}).promise().
      then(_ => {

        console.log("Waiting for termination...")
        return this.ec2.waitFor("instanceTerminated", {
          InstanceIds: [instanceId]}).promise()
      }).then(_ => {
        console.log("Done terminating!")
      })
    })
  }

  restartSteam() {
    return this.getInstance().then(instance => {
      console.log("Sending restart command...")
      return this.ssm.sendCommand({
        DocumentName: "AWS-RunPowerShellScript",
        InstanceIds: [instance.InstanceId],
        Parameters: {
          commands: ["Start-ScheduledTask \"CloudyGamer Restart Steam\""]
        }}).promise().
      then(_ => {
        console.log("Steam restart command successfully sent")
        return
      })
    }).catch(err => {
      console.error(err)
    })
  }

  isVolumeAvailable() {
    return this.ec2.describeVolumes({
      VolumeIds: [CLOUDYGAMER_VOLUME]}).promise().
    then(data => {
      return data.Volumes[0].State === "available"
    })
  }

  isInstanceOnline(instanceId) {
    return this.ssm.describeInstanceInformation({
      InstanceInformationFilterList: [{
        key: "InstanceIds",
        valueSet: [instanceId]
      }]}).promise().
    then(data => {
      return data.InstanceInformationList[0].PingStatus === "Online"
    })
  }

  getInstance(instanceId = null) {
    const params = instanceId ? {
      InstanceIds: [instanceId]
    } : {
      Filters: [{
        Name: "image-id",
        Values: [AMI]
      }, {
        Name: "instance-state-name",
        Values: ["pending", "running", "stopping"]
      }]
    }

    return this.ec2.describeInstances(params).promise().then(data => {
      if (data.Reservations.length > 0) {
        return data.Reservations[0].Instances[0]
      }

      throw new Error("cloudygamer instance not found")
    })
  }
}
