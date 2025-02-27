/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */
const { MediaConvert } = require("@aws-sdk/client-mediaconvert");
const { S3 } = require("@aws-sdk/client-s3");
const { SNS } = require("@aws-sdk/client-sns");

/**
 * Download Job Settings from s3 and run a basic validationvalidate 
*/
const getJobSettings = async (bucket, settingsFile) => {
    console.log(`Downloading Job Settings file: ${settingsFile}, from S3: ${bucket}`);
    let settings;
    try {
        /**
         * Download the dsettings file for S3
         */
        const s3 = new S3();
        settings = await s3.getObject({
            Bucket: bucket,
            Key: settingsFile
        });
        settings = JSON.parse(await settings.Body.transformToString());
        /**
         * Basic file validation for the settings file
         * 
         */
        if (!("Settings" in settings) || (("Inputs" in settings) && settings.Inputs.length > 1)){
            throw new Error('Invalid settings file in s3');
        }
    } catch (err) {
        const error = new Error('Failed to download and validate the job-settings.json file. Please check its contents and location. Details  on using custom settings: https://github.com/awslabs/video-on-demand-on-aws-foundations');
        error.Error = err.toString();
        throw error;
    }
    return settings;
};

/**
 * Parse the job settings file and update the inputs/outputs. the num values are
 * to dupport multiple output groups of the same type. 
 * 
 */
const updateJobSettings = async (job, inputPath, outputPath, metadata, role) => {
    console.log(`Updating Job Settings with the source and destination details`);
    const getPath = (group, num) => {
        try {
            let path = '';
            if (group.CustomName) {
                path = `${outputPath}/${group.CustomName.replace(/\s+/g, '')}/`;
            } else {
                path = `${outputPath}/${group.Name.replace(/\s+/g, '')}${num}/`;
            }
            return path;
        } catch (err) {
            throw Error('Cannot validate group name in job.Settings.OutputGroups. Please check your job settings file.');
        }
    };
    try {
        let fileNum = 1;
        let hlsNum = 1;
        let dashNum = 1;
        let mssNum = 1;
        let cmafNum = 1;
        job.Settings.Inputs[0].FileInput = inputPath;
        const outputGroups = job.Settings.OutputGroups;
        for (let group of outputGroups) {
            switch (group.OutputGroupSettings.Type) {
                case 'FILE_GROUP_SETTINGS':
                    group.OutputGroupSettings.FileGroupSettings.Destination = getPath(group, fileNum++);
                    break;
                case 'HLS_GROUP_SETTINGS':
                    group.OutputGroupSettings.HlsGroupSettings.Destination = getPath(group, hlsNum++);
                    break;
                case 'DASH_ISO_GROUP_SETTINGS':
                    group.OutputGroupSettings.DashIsoGroupSettings.Destination = getPath(group, dashNum++);
                    break;
                case 'MS_SMOOTH_GROUP_SETTINGS':
                    group.OutputGroupSettings.MsSmoothGroupSettings.Destination = getPath(group, mssNum++);
                    break;
                case 'CMAF_GROUP_SETTINGS':
                    group.OutputGroupSettings.CmafGroupSettings.Destination = getPath(group, cmafNum++);
                    break;
                default:
                    throw Error('OutputGroupSettings.Type is not a valid type. Please check your job settings file.');
            }
        }
        /**
         * Default setting of preferred will enable acceleration if the source file is supported.
         */
        if (!("AccelerationSettings" in job)) {
            job.AccelerationSettings = "PREFERRED";
        }
        job.Role = role;
        /**
         * if Queue is included, make sure it's just the queue name and not the ARN
        */
        if ( job.Queue && job.Queue.split("/").length > 1) {
            job.Queue = job.Queue.split("/")[1];
        }
        /**
         * merge user defined metadata with the solution metadata. this is used to track 
         * jobs submitted to MediaConvert by the solution
        */
        job.UserMetadata = {...job.UserMetadata, ...metadata};
    } catch (err) {
        const error = new Error('Failed to update the job-settings.json file. Details on using custom settings: https://github.com/awslabs/video-on-demand-on-aws-foundations');
        error.Error = err.toString();
        throw error;
    }
    return job;
};

/**
 * Create and encoding job in MediaConvert
 */
const createJob = async (job, endpoint) => {
    const mediaconvert = new MediaConvert({
        endpoint: endpoint,
        customUserAgent: process.env.SOLUTION_IDENTIFIER
    });
    try {
        const jobResponse = await mediaconvert.createJob(job);
        // console.log(`job response : ${JSON.stringify(jobResponse)}`);
        // console.log(`awsJobId: ${jobResponse.Job.Id}, resourceFileName: ${getFileNameFromPath(jobResponse.Job.Settings.Inputs[0].FileInput)}`);

        // TODO - handle dev, staging and prod environments
        await fetch('https://backend-dev.relata.io/api/v1/catalog/media-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                awsJobId: jobResponse.Job.Id,
                resourceFileName: getFileNameFromPath(jobResponse.Job.Settings.Inputs[0].FileInput)
            })
        });

        console.log(`job subbmited to MediaConvert:: ${JSON.stringify(job, null, 2)}`);
    } catch (err) {
        console.error(err);
        throw err;
    }
};


/**
 * Send An sns notification for any failed jobs
 */
const sendError = async (topic,stackName,logGroupName,err) => {
    console.log(`Sending SNS error notification: ${err}`);
    const sns = new SNS({
        region: process.env.REGION
    });
    try {
        const msg = {
            Details: `https://console.aws.amazon.com/cloudwatch/home?region=${process.env.AWS_REGION}#logStream:group=${logGroupName}`,
            Error: err
        };
        await sns.publish({
            TargetArn: topic,
            Message: JSON.stringify(msg, null, 2),
            Subject: `${stackName}: Encoding Job Submit Failed`,
        });
    } catch (err) {
        console.error(err);
        throw err;
    }
};

const removeFileExtension = (s3Path) => {
  // Regular expression to remove the file extension, but keep the file name
  return s3Path.replace(/\.[^\/]+$/, '');
}

/**
 * Extracts the filename from an S3 file path.
 * 
 * @param {string} filePath - The full S3 file path.
 * @returns {string} - The filename extracted from the path.
 */
const getFileNameFromPath = (filePath) => {
    // Use the split method to divide the path by '/' and get the last element
    const parts = filePath.split('/');
    return parts[parts.length - 1];
};


module.exports = {
    getJobSettings: getJobSettings,
    updateJobSettings: updateJobSettings,
    createJob: createJob,
    sendError: sendError,
    removeFileExtension: removeFileExtension
};