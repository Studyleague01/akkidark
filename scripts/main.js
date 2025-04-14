const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// API endpoints
const MP3_API = "https://backendmix.vercel.app/mp3";
const FALLBACK_API = "https://ytdlp-api-ox2d.onrender.com/rv";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";

// Configuration
const TEMP_DOWNLOAD_DIR = path.join(__dirname, "..", "temp_downloads");
const DOWNLOADS_JSON = path.join(__dirname, "..", "downloads.json");
const MAX_RETRIES = 5;

// List of channel IDs to process
const CHANNEL_IDS = [
    'UC0XWC2_UZMkXPGn4bj0R2Uw', //scary pumpkin
    'UCpGhKw1m80zRsS7xUvUruaQ', //Once Upon A Time - Horror Hindi
    'UC2OE2tbj4O3wo14M-tspGzw' //HORROR PODCAST SHOW
];

// Internet Archive configuration
const IA_IDENTIFIER = "akkidark";
const IA_ACCESS_KEY = "cCYXD3V4ke4YkXLI";
const IA_SECRET_KEY = "qZHSAtgw5TJXkpZa";
const IA_BASE_URL = `https://archive.org/serve/${IA_IDENTIFIER}/`;

// Ensure the download directory exists
fs.ensureDirSync(TEMP_DOWNLOAD_DIR);

// Load existing downloads data
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
        console.log(`📋 Loaded ${Object.keys(downloadsData).length} existing downloads from JSON`);
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

/**
 * Upload multiple files to Internet Archive with enhanced progress indication
 * @param {Array} filesToUpload Array of {filePath, videoId, title} objects
 * @returns {Array} Results with success/failure for each file
 */
async function batchUploadToInternetArchive(filesToUpload) {
    console.log(`📤 Batch uploading ${filesToUpload.length} files to Internet Archive...`);
    
    // Create Python script for batch upload with enhanced progress updates
    const pythonScript = `
import os
import sys
import json
import time
import internetarchive

# Load batch data
batch_data = json.loads(sys.argv[1])
total_files = len(batch_data)

# Internet Archive credentials
access_key = "${IA_ACCESS_KEY}"
secret_key = "${IA_SECRET_KEY}"
identifier = "${IA_IDENTIFIER}"

# Process each file
results = []
progress_file = os.path.join("${TEMP_DOWNLOAD_DIR}", "upload_progress.json")

# Initialize progress tracking
progress_data = {
    "total": total_files,
    "completed": 0,
    "current_file": "",
    "current_title": "",
    "current_size": 0,
    "current_progress": 0,  # Upload percentage for current file
    "success_count": 0,
    "failed_count": 0,
    "status_by_id": {},
    "start_time": time.time(),
    "last_update_time": time.time(),
    "estimated_remaining": 0
}

def update_progress(video_id, title, file_size, status, progress_pct=100, message=""):
    now = time.time()
    progress_data["completed"] += 1 if status or progress_pct >= 100 else 0
    progress_data["current_file"] = video_id
    progress_data["current_title"] = title
    progress_data["current_size"] = file_size
    progress_data["current_progress"] = progress_pct
    
    # Update success/failure counts only when a file is fully processed
    if progress_pct >= 100:
        if status:
            progress_data["success_count"] += 1
        else:
            progress_data["failed_count"] += 1
    
    progress_data["status_by_id"][video_id] = {
        "status": "success" if status else "failed" if progress_pct >= 100 else "in_progress",
        "progress": progress_pct,
        "message": message,
        "title": title,
        "size": file_size
    }
    
    # Calculate time estimates
    elapsed_time = now - progress_data["start_time"]
    if progress_data["completed"] > 0:
        avg_time_per_file = elapsed_time / progress_data["completed"]
        remaining_files = total_files - progress_data["completed"]
        # If current file is in progress, count it as partially complete
        if progress_pct > 0 and progress_pct < 100:
            remaining_files -= (progress_pct / 100)
        progress_data["estimated_remaining"] = avg_time_per_file * remaining_files
    
    progress_data["last_update_time"] = now
    
    # Write progress to file
    with open(progress_file, 'w') as f:
        json.dump(progress_data, f)
    
    # Print progress for stdout capture
    percent = (progress_data["completed"] / progress_data["total"]) * 100
    if progress_pct < 100:
        status_msg = f"UPLOADING: {video_id} - {progress_pct:.1f}% complete"
    else:
        status_msg = f"COMPLETED: {video_id} - {'SUCCESS' if status else 'FAILED'}"
    
    print(f"PROGRESS_UPDATE: {percent:.1f}% complete ({progress_data['completed']}/{progress_data['total']}) - {status_msg}")

# Create upload callback to track individual file progress
class UploadProgressCallback:
    def __init__(self, file_info):
        self.file_info = file_info
        self.video_id = file_info["videoId"]
        self.title = file_info["title"]
        self.size = file_info["size"]
        self.last_percent = 0
        self.update_threshold = 5  # Update every 5% progress to avoid too frequent updates
    
    def __call__(self, bytes_sent, bytes_total):
        if bytes_total > 0:
            percent = (bytes_sent / bytes_total) * 100
            # Only update if progress has increased by threshold amount
            if percent - self.last_percent >= self.update_threshold or percent >= 100:
                self.last_percent = percent
                update_progress(self.video_id, self.title, self.size, True, percent)
        return True

# Start with empty progress file
with open(progress_file, 'w') as f:
    json.dump(progress_data, f)

for index, item in enumerate(batch_data):
    filepath = item["filePath"]
    video_id = item["videoId"]
    title = item["title"]
    file_size = item["size"]
    filename = os.path.basename(filepath)
    
    print(f"Uploading {filename} ({index+1}/{total_files})...")
    
    # Create progress callback for this file
    progress_callback = UploadProgressCallback(item)
    
    try:
        # First update to show we're starting this file
        update_progress(video_id, title, file_size, True, 0, "Starting upload")
        
        response = internetarchive.upload(
            identifier=identifier,
            files=[filepath],
            metadata={
                "title": title,
                "mediatype": "audio",
                "collection": "opensource_audio",
                "creator": "YouTube Clone - ShradhaKD",
                "youtube_id": video_id
            },
            config={
                "s3": {
                    "access": access_key,
                    "secret": secret_key
                }
            },
            verbose=True,
            callback=progress_callback  # Use our custom callback
        )
        
        success = True
        error_message = ""
        
        for r in response:
            if r.status_code != 200:
                error_message = f"Upload failed with status {r.status_code}"
                print(f"❌ Upload failed for {filename} with status {r.status_code}: {r.text}")
                success = False
            else:
                print(f"✅ Successfully uploaded {filename}")
        
        # Final update with complete status
        update_progress(video_id, title, file_size, success, 100, error_message)
        
        results.append({
            "videoId": video_id,
            "success": success
        })
        
    except Exception as e:
        error_str = str(e)
        print(f"❌ Exception uploading {filename}: {error_str}")
        update_progress(video_id, title, file_size, False, 100, error_str)
        
        results.append({
            "videoId": video_id,
            "success": False
        })
    
    # Short delay between uploads
    time.sleep(1)

# Output results as JSON
print("FINAL_RESULTS:" + json.dumps(results))
`;

    try {
        const scriptPath = path.join(TEMP_DOWNLOAD_DIR, "batch_upload_script.py");
        fs.writeFileSync(scriptPath, pythonScript);
        
        // Create JSON string of files to upload
        const batchDataJson = JSON.stringify(filesToUpload);
        
        // Create progress tracking function
        const progressFilePath = path.join(TEMP_DOWNLOAD_DIR, "upload_progress.json");
        
        // Setup enhanced progress monitoring
        const progressInterval = setInterval(() => {
            try {
                if (fs.existsSync(progressFilePath)) {
                    const progressData = JSON.parse(fs.readFileSync(progressFilePath, "utf-8"));
                    const percent = (progressData.completed / progressData.total) * 100;
                    const progressBar = createDetailedProgressBar(percent);
                    const elapsedMinutes = ((Date.now() / 1000) - progressData.start_time) / 60;
                    const remainingMinutes = progressData.estimated_remaining / 60;
                    
                    // Clear the current line
                    process.stdout.write("\r".padEnd(100, " "));
                    
                    // Print overall progress
                    process.stdout.write(`\r${progressBar} ${percent.toFixed(1)}% | ${progressData.completed}/${progressData.total} | ✓${progressData.success_count} | ✗${progressData.failed_count}`);
                    
                    // Add time estimates
                    if (elapsedMinutes > 0 && progressData.completed > 0) {
                        process.stdout.write(` | ⏱️ ${elapsedMinutes.toFixed(1)}m elapsed`);
                        
                        if (remainingMinutes > 0 && progressData.completed < progressData.total) {
                            process.stdout.write(` | ⏳ ~${remainingMinutes.toFixed(1)}m remaining`);
                        }
                    }
                    
                    // Add details about current file if one is in progress
                    if (progressData.current_file && progressData.current_progress < 100) {
                        // Move to next line for file details
                        process.stdout.write("\n");
                        
                        // Show progress for current file
                        const fileProgressBar = createDetailedProgressBar(progressData.current_progress);
                        const fileSizeMB = (progressData.current_size / (1024 * 1024)).toFixed(2);
                        const truncatedTitle = progressData.current_title.length > 40 ? 
                            progressData.current_title.substring(0, 37) + "..." : 
                            progressData.current_title;
                        
                        process.stdout.write(`   ${fileProgressBar} ${progressData.current_progress.toFixed(1)}% | ${progressData.current_file} | ${fileSizeMB} MB | ${truncatedTitle}`);
                    }
                }
            } catch (err) {
                // Ignore progress reading errors
            }
        }, 500);
        
        // Run Python upload script with batch data
        const result = spawnSync("python", [scriptPath, batchDataJson], {
            encoding: "utf-8",
            stdio: "pipe",
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large output
        });
        
        // Stop progress monitoring
        clearInterval(progressInterval);
        process.stdout.write("\n\n"); // Move to next line after progress bar
        
        if (result.status !== 0) {
            console.error(`❌ Batch upload script failed: ${result.stderr}`);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
        
        // Try to parse results from the script output
        try {
            // Find and extract the JSON part from the output
            const outputLines = result.stdout.split('\n');
            const jsonLine = outputLines.filter(line => line.includes('FINAL_RESULTS:')).pop();
            
            if (jsonLine) {
                const jsonStr = jsonLine.replace('FINAL_RESULTS:', '');
                return JSON.parse(jsonStr);
            } else {
                console.error("❌ Could not find JSON results in script output");
                return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
            }
        } catch (parseErr) {
            console.error(`❌ Failed to parse upload results: ${parseErr.message}`);
            console.log("Script output:", result.stdout);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
    } catch (err) {
        console.error(`❌ Error in batch upload: ${err.message}`);
        return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
    } finally {
        // Clean up progress file
        try {
            if (fs.existsSync(progressFilePath)) {
                fs.unlinkSync(progressFilePath);
            }
        } catch (err) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Create a detailed visual progress bar with color indicators
 * @param {number} percent Percentage complete (0-100)
 * @returns {string} Enhanced ASCII progress bar
 */
function createDetailedProgressBar(percent) {
    const width = 25;
    const completed = Math.floor(width * (percent / 100));
    const current = percent < 100 && completed < width ? 1 : 0; 
    const remaining = width - completed - current;
    
    // Use different characters for better visibility
    const completedChar = '█';
    const currentChar = '▓';
    const remainingChar = '▒';
    
    return `[${completedChar.repeat(completed)}${currentChar.repeat(current)}${remainingChar.repeat(remaining)}]`;
}

/**
 * Try to download using fallback API
 * @param {string} videoId YouTube video ID
 * @returns {Promise<{url: string, title: string}>} Download URL and title
 */
async function tryFallbackApi(videoId) {
    console.log(`🔄 Trying fallback API for ${videoId}...`);
    
    try {
        const fallbackResponse = await axios.get(`${FALLBACK_API}/${videoId}`, {
            timeout: 120000 // 2 minute timeout since this API can be slow (15s-1min)
        });
        
        if (!fallbackResponse.data || !fallbackResponse.data.url) {
            throw new Error("No URL in fallback API response");
        }
        
        return {
            url: fallbackResponse.data.url,
            filename: fallbackResponse.data.title || `Video ${videoId}`
        };
    } catch (err) {
        console.error(`❌ Fallback API failed: ${err.message}`);
        throw err; // Re-throw to be handled by caller
    }
}

/**
 * Commit changes to the downloads.json file
 */
function commitChangesToJson() {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Update downloads.json with newly processed videos"`);
        execSync("git push");
        console.log(`📤 Committed and pushed updates to downloads.json`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}

/**
 * Download a file with progress tracking
 * @param {string} url URL to download from
 * @param {string} filePath Path to save file to
 * @param {string} videoId Video ID for logging
 * @returns {Promise<number>} File size in bytes
 */
async function downloadFileWithProgress(url, filePath, videoId) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                timeout: 60000
            });
            
            const totalSize = parseInt(response.headers['content-length'] || 0);
            let downloadedSize = 0;
            let lastLoggedPercent = -5; // Start at -5 to ensure first update is printed
            
            // Create writer stream
            const writer = fs.createWriteStream(filePath);
            writer.on('error', err => reject(err));
            writer.on('finish', () => {
                process.stdout.write('\n'); // Move to next line after progress
                resolve(downloadedSize);
            });
            
            // Setup download progress tracking
            response.data.on('data', chunk => {
                downloadedSize += chunk.length;
                
                if (totalSize) {
                    const percent = (downloadedSize / totalSize) * 100;
                    // Only update every 5% to avoid console spam
                    if (percent - lastLoggedPercent >= 5 || percent >= 99.9) {
                        lastLoggedPercent = percent;
                        const progressBar = createDetailedProgressBar(percent);
                        const sizeMB = (downloadedSize / (1024 * 1024)).toFixed(2);
                        const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
                        process.stdout.write(`\r📥 ${videoId}: ${progressBar} ${percent.toFixed(1)}% (${sizeMB}/${totalMB} MB)`);
                    }
                }
            });
            
            // Pipe response to file
            response.data.pipe(writer);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Process a single channel
 * @param {string} channelId The YouTube channel ID to process
 * @returns {object} Statistics for this channel's processing
 */
async function processChannel(channelId) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎬 PROCESSING CHANNEL: ${channelId}`);
    console.log(`${'='.repeat(80)}`);
    
    try {
        console.log(`🔍 Fetching videos for channel ID: ${channelId}...`);
        const response = await axios.get(`${CHANNEL_API}/${channelId}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error(`❌ No videos found for channel ${channelId}.`);
            return {
                channelId,
                total: 0,
                processed: 0,
                skipped: 0,
                errors: 0
            };
        }

        const videoIds = response.data.videos;
        console.log(`📹 Found ${videoIds.length} videos, checking which ones need processing...`);

        // Filter videos that need processing
        const videosToProcess = [];
        for (const videoId of videoIds) {
            if (!(downloadsData[videoId] && downloadsData[videoId].filePath)) {
                videosToProcess.push(videoId);
            }
        }
        
        const skippedCount = videoIds.length - videosToProcess.length;
        console.log(`⏭️ Skipping ${skippedCount} already processed videos`);
        console.log(`🔄 Processing ${videosToProcess.length} new videos`);

        let processedCount = 0;
        let errorCount = 0;
        let fallbackCount = 0;
        
        // Track downloaded files for batch upload
        const downloadedFiles = [];
        const failedIds = [];

        // PHASE 1: DOWNLOAD ALL FILES - WITH PROGRESS DISPLAY
        console.log(`\n📥 PHASE 1: DOWNLOADING ALL FILES`);
        console.log(`${'='.repeat(50)}`);
        
        const downloadStartTime = Date.now();
        
        for (let i = 0; i < videosToProcess.length; i++) {
            const videoId = videosToProcess[i];
            const filename = `${videoId}.webm`;
            const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);

            // Calculate and show progress statistics
            if (i > 0) {
                const elapsedSeconds = (Date.now() - downloadStartTime) / 1000;
                const avgTimePerVideo = elapsedSeconds / i;
                const remainingVideos = videosToProcess.length - i;
                const estimatedRemainingSeconds = avgTimePerVideo * remainingVideos;
                const remainingMinutes = Math.floor(estimatedRemainingSeconds / 60);
                const remainingSeconds = Math.floor(estimatedRemainingSeconds % 60);
                
                console.log(`\n⏱️ Progress: ${i}/${videosToProcess.length} videos (${(i/videosToProcess.length*100).toFixed(1)}%) | Est. remaining: ${remainingMinutes}m ${remainingSeconds}s`);
            }
            
            console.log(`\n📥 Downloading video ${i + 1}/${videosToProcess.length}: ${videoId}`);

            let downloadSuccess = false;
            let videoTitle = `Video ${videoId}`;
            let usedFallback = false;
            let fileSize = 0;
            
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`🔄 Download attempt ${attempt}/${MAX_RETRIES} for ${videoId}...`);
                    }

                    let url, titleFromApi;
                    
                    // Try primary API first
                    if (!usedFallback && attempt <= MAX_RETRIES - 1) {
                        try {
                            const downloadResponse = await axios.get(`${MP3_API}/${videoId}`, {
                                timeout: 30000 // 30 second timeout
                            });
                            url = downloadResponse.data.url;
                            titleFromApi = downloadResponse.data.filename;
                            
                            if (!url) {
                                throw new Error("No download URL returned from primary API");
                            }
                        } catch (primaryApiErr) {
                            console.error(`⚠️ Primary API failed: ${primaryApiErr.message}`);
                            
                            // If we're on the last retry attempt, switch to fallback
                            if (attempt === MAX_RETRIES - 1) {
                                usedFallback = true;
                                const fallbackResult = await tryFallbackApi(videoId);
                                url = fallbackResult.url;
                                titleFromApi = fallbackResult.filename;
                                console.log(`🔀 Switched to fallback API for ${videoId}`);
                                fallbackCount++;
                            } else {
                                throw primaryApiErr; // Re-throw to retry with primary API
                            }
                        }
                    } else if (usedFallback || attempt === MAX_RETRIES) {
                        // On the last attempt or if we've already decided to use fallback
                        usedFallback = true;
                        const fallbackResult = await tryFallbackApi(videoId);
                        url = fallbackResult.url;
                        titleFromApi = fallbackResult.filename;
                        if (!usedFallback) fallbackCount++; // Only increment if first time using fallback
                    }

                    // Clean up filename to use as title (remove .mp3 extension if present)
                    videoTitle = titleFromApi 
                        ? titleFromApi.replace(/\.mp3$/, '').trim() 
                        : `Video ${videoId}`;

                    // Download the audio file with progress
                    console.log(`📥 Starting download from ${usedFallback ? 'fallback' : 'primary'} API source...`);
                    fileSize = await downloadFileWithProgress(url, filePath, videoId);

                    if (fileSize === 0) {
                        throw new Error("Downloaded file size is 0 bytes");
                    }

                    console.log(`✅ Downloaded ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`📝 Title: ${videoTitle}`);
                    if (usedFallback) {
                        console.log(`ℹ️ Used fallback API for this download`);
                    }

                    downloadedFiles.push({
                        filePath: filePath,
                        videoId: videoId,
                        title: videoTitle,
                        size: fileSize
                    });
                    
                    downloadSuccess = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ Error downloading ${videoId}: ${err.message}`);
                    
                    // Clean up partial download if it exists
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Removed failed download: ${filePath}`);
                        } catch (cleanupErr) {
                            console.error(`⚠️ Failed to clean up file: ${cleanupErr.message}`);
                        }
                    }
                    
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed to download ${videoId} after ${MAX_RETRIES} attempts, skipping.`);
                        failedIds.push(videoId);
                        errorCount++;
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (!downloadSuccess) {
                console.error(`🚨 Failed to download: ${videoId}`);
            }
        }
        
        console.log(`${'='.repeat(50)}`);
        console.log(`📥 Download phase complete: ${downloadedFiles.length} files downloaded, ${failedIds.length} failed`);
        console.log(`🔀 Used fallback API for ${fallbackCount} downloads`);

        // PHASE 2: BATCH UPLOAD ALL DOWNLOADED FILES - WITH ENHANCED PROGRESS DISPLAY
        console.log(`\n📤 PHASE 2: BATCH UPLOADING ${downloadedFiles.length} FILES`);
        console.log(`${'='.repeat(50)}`);
        
        if (downloadedFiles.length > 0) {
            // Batch upload all files with enhanced progress reporting
            const uploadResults = await batchUploadToInternetArchive(downloadedFiles);
            
            console.log(`\n${'-'.repeat(50)}`);
            console.log(`📊 Upload Results Summary:`);
            
            // Calculate upload success stats
            const successfulUploads = uploadResults.filter(r => r.success).length;
            const failedUploads = uploadResults.filter(r => !r.success).length;
            console.log(`✅ Successfully uploaded: ${successfulUploads}/${uploadResults.length} files (${((successfulUploads/uploadResults.length)*100).toFixed(1)}%)`);
            console.log(`❌ Failed uploads: ${failedUploads}`);
            
            // Process results and update downloads.json
            console.log(`\n📝 Updating records in downloads.json...`);
            
            for (const result of uploadResults) {
                const { videoId, success } = result;
                const fileInfo = downloadedFiles.find(file => file.videoId === videoId);
                
                if (success && fileInfo) {
                    const filename = path.basename(fileInfo.filePath);
                    const iaFilePath = `${IA_BASE_URL}${filename}`;
                    
                    // Update downloads.json with SAME structure as your existing entries
                    // NO additional fields to maintain compatibility
                    downloadsData[videoId] = {
                        title: fileInfo.title,
                        id: videoId,
                        filePath: iaFilePath,
                        size: fileInfo.size,
                        uploadDate: new Date().toISOString()
                    };
                    
                    processedCount++;
                } else if (!success) {
                    errorCount++;
                }
            }
            
            // Save updated downloads JSON
            fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));
            console.log(`📝 Updated downloads.json with ${processedCount} new entries for channel ${channelId}`);
            
            // Commit changes
            if (processedCount > 0) {
                commitChangesToJson();
            }
        } else {
            console.log(`⏭️ No new files to upload`);
        }
        console.log(`${'='.repeat(50)}`);

        // PHASE 3: CLEANUP
        console.log(`\n🧹 PHASE 3: CLEANING UP DOWNLOADED FILES`);
        console.log(`${'='.repeat(50)}`);
        
        // Clean up downloaded files
        let cleanedUp = 0;
        for (const fileInfo of downloadedFiles) {
            try {
                if (fs.existsSync(fileInfo.filePath)) {
                    fs.unlinkSync(fileInfo.filePath);
                    cleanedUp++;
                }
            } catch (err) {
                console.error(`⚠️ Error deleting ${fileInfo.filePath}: ${err.message}`);
            }
        }
        console.log(`🗑️ Removed ${cleanedUp} downloaded files`);
        console.log(`${'='.repeat(50)}`);

        console.log(`\n📊 Channel Summary for ${channelId}:`);
        console.log(`✅ Successfully processed: ${processedCount} videos`);
        console.log(`⏭️ Skipped (already processed): ${skippedCount} videos`);
        console.log(`❌ Failed: ${errorCount} videos`);
        console.log(`🔀 Used fallback API: ${fallbackCount} times`);
        
        return {
            channelId,
            total: videoIds.length,
            processed: processedCount,
            skipped: skippedCount,
            errors: errorCount,
            fallbackUsed: fallbackCount
        };
    } catch (error) {
        console.error(`❌ Error processing channel ${channelId}:`, error.message);
        return {
            channelId,
            total: 0,
            processed: 0,
            skipped: 0,
            errors: 1,
            fallbackUsed: 0,
            error: error.message
        };
    }
}

/**
 * Main function to process all channels one by one
 */
(async () => {
    try {
        console.log(`🚀 Starting multi-channel processing job for ${CHANNEL_IDS.length} channels`);
        console.log(`${'='.repeat(80)}`);
        
        const channelResults = [];
        let totalProcessed = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        let totalVideos = 0;
        let totalFallbackUsed = 0;
        
        const totalStartTime = Date.now();

        // Process each channel one by one
        for (let i = 0; i < CHANNEL_IDS.length; i++) {
            const channelId = CHANNEL_IDS[i];
            const channelStartTime = Date.now();
            
            console.log(`\n🎬 Processing channel ${i+1}/${CHANNEL_IDS.length}: ${channelId}`);
            
            // Calculate progress if we have processed some channels
            if (i > 0) {
                const elapsedMinutes = (Date.now() - totalStartTime) / 1000 / 60;
                const avgTimePerChannel = elapsedMinutes / i;
                const remainingChannels = CHANNEL_IDS.length - i;
                const estRemainingMinutes = avgTimePerChannel * remainingChannels;
                
                console.log(`⏱️ Overall progress: ${i}/${CHANNEL_IDS.length} channels (${(i/CHANNEL_IDS.length*100).toFixed(1)}%)`);
                console.log(`⏱️ Time elapsed: ${elapsedMinutes.toFixed(1)} minutes | Est. remaining: ${estRemainingMinutes.toFixed(1)} minutes`);
            }
            
            const result = await processChannel(channelId);
            channelResults.push(result);
            
            totalProcessed += result.processed;
            totalSkipped += result.skipped;
            totalErrors += result.errors;
            totalVideos += result.total;
            totalFallbackUsed += result.fallbackUsed || 0;
            
            // Report time taken for this channel
            const channelMinutes = (Date.now() - channelStartTime) / 1000 / 60;
            console.log(`⏱️ Channel completed in ${channelMinutes.toFixed(1)} minutes`);
            
            // Clean up any temporary files that might remain
            try {
                const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR)
                    .filter(file => file.endsWith('.webm'));
                
                if (tempFiles.length > 0) {
                    console.log(`🧹 Cleaning up ${tempFiles.length} remaining temporary files...`);
                    tempFiles.forEach(file => {
                        const filePath = path.join(TEMP_DOWNLOAD_DIR, file);
                        fs.unlinkSync(filePath);
                    });
                }
            } catch (err) {
                console.error(`⚠️ Error during cleanup: ${err.message}`);
            }
        }

        // Calculate total time
        const totalMinutes = (Date.now() - totalStartTime) / 1000 / 60;

        // Print final summary
        console.log(`\n\n${'='.repeat(80)}`);
        console.log(`📊 FINAL SUMMARY FOR ALL ${CHANNEL_IDS.length} CHANNELS`);
        console.log(`${'='.repeat(80)}`);
        console.log(`⏱️ Total execution time: ${totalMinutes.toFixed(1)} minutes`);
        console.log(`Total videos found: ${totalVideos}`);
        console.log(`✅ Successfully processed: ${totalProcessed} videos`);
        console.log(`⏭️ Skipped (already processed): ${totalSkipped} videos`);
        console.log(`❌ Failed: ${totalErrors} videos`);
        console.log(`🔀 Used fallback API: ${totalFallbackUsed} times`);
        console.log(`🌐 Internet Archive collection: https://archive.org/details/${IA_IDENTIFIER}`);
        console.log(`${'='.repeat(80)}`);
        
        // Print individual channel results
        console.log(`\nChannel-by-channel results:`);
        channelResults.forEach((result, index) => {
            console.log(`${index+1}. ${result.channelId}: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} failed, ${result.fallbackUsed || 0} fallback API used`);
        });
        
    } catch (error) {
        console.error("❌ Fatal Error:", error.message);
        process.exit(1);
    }
})();
