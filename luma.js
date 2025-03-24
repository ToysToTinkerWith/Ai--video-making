import fs from "fs";
import https from "https"
import OpenAI from "openai";


import ffmpegPath from "@ffmpeg-installer/ffmpeg"
import ffmpeg from "fluent-ffmpeg"

import path from "path";
import { timeStamp } from "console";
import { stringify } from "querystring";

import { fileURLToPath } from 'url';
import { dirname } from 'path';

// This gives you the equivalent of __filename
const __filename = fileURLToPath(import.meta.url);

// Then define __dirname
const __dirname = dirname(__filename);

import readline from "readline"

ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

import LumaAI from "lumaai"
import fetch from "node-fetch"

import { initializeApp, getApps } from "firebase/app"
import { getStorage } from "firebase/storage"
import { ref, uploadBytes, uploadBytesResumable, getDownloadURL, listAll } from "firebase/storage";

const firebaseConfig = {
  
}

let firebase_app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

const storage = getStorage(firebase_app)

var video = new ffmpeg('aoe2.mp4')

const openai = new OpenAI({
    apiKey: ""
});

const client = new LumaAI({
    authToken: ""
});

let videoLength = 975
let pastStories = []

let inputFiles = []

let segments = []

async function saveFrames() {
  return new Promise(async (resolve) => {
      await video
      .on('filenames', function(filenames) {
          console.log('Screenshots are being saved as: ' + filenames.join(', '));
      })
      .on('end', function() {
          console.log('Screenshots taken');
          resolve()
      })
      .on('error', function(err) {
          console.error('An error occurred: ' + err.message);
      })
      .screenshots({
          timestamps: Array.from({ length: Math.floor(videoLength / 29) }, (_, i) => i * 30),
          filename: 'thumbnail-at-%s-seconds.png',
          folder: "screenshots",
          size: '1280x720'
      });
  });
}

const uploadScreenshotImages = async () => {

    fs.readdirSync("screenshots").forEach(file => {
        
        const filePath = path.join("screenshots", file); // Adjust path/filename as needed

        fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error('Error reading file:', err);
            return;
        }

        // 'data' is a Buffer instance, representing raw bytes
        console.log('Buffer:', data);
        console.log('Buffer length (bytes):', data.length);
        
        // If you want a typed array:
        const uint8Array = new Uint8Array(data);
        console.log('Uint8Array:', uint8Array);

        // Create a storage reference
            const storageRef = ref(storage, `uploads/` + file);

            // Start the upload
            const uploadTask = uploadBytesResumable(storageRef, data);

            // Listen for state changes
            uploadTask.on(
            "state_changed",
            (snapshot) => {
                // Compute progress
                const progress =
                (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            console.log(progress)
            },
            (error) => {
                console.error("Upload failed:", error);
                alert("Upload failed, see console for details");
            },
            async () => {
                // Upload completed successfully, get download URL
                const url = await getDownloadURL(uploadTask.snapshot.ref);
                console.log(url)
            }
            );
        });

    })

}


const ScreenshotToStory = async () => {
    try {

      

    // 1) Create a reference to the folder
      const folderRef = ref(storage, "uploads/");

      // 2) List all items (files) in that folder
      const result = await listAll(folderRef);

      // 3) For each item, get the download URL
      const urlPromises = result.items.map((itemRef) => getDownloadURL(itemRef));
      const urls = await Promise.all(urlPromises);

      function getSecondNumber(str) {
        const matches = str.match(/\d+/g); // all digit sequences
        if (matches && matches.length >= 2) {
          return parseInt(matches[4], 10); // second match
        }
        return Infinity; // fallback if second number doesn't exist
      }
      
      // Sort using the second number
      urls.sort((a, b) => {
        return getSecondNumber(a) - getSecondNumber(b);
      });

      let prevStory = "The bulagrian villagers began their day, their thoughts on their newly discovered decentralized currency: Dark Coin"
      
      let count = 1

      console.log(urls)

      while (count < urls.length) {

        let text = "The game is Age of Empires 2.  The player being shown is 'Dark Coin'. Create a story based on the first image going to the second. Just return the text of the story. Dark Coin is red color, his enemy is in the Blue color. "
    
        let darkCoinDetails = [
            "Dark Coin (ASA-1088771340) Dark Coin is an innovative community-driven project within the Algorand ecosystem, focused on expanding the possibilities of Algorand Standard Assets (ASAs) in the decentralized finance (DeFi) space. It operates as a decentralized autonomous organization (DAO), giving collective ownership and democratic management power to its members through blockchain-enforced rules. Key Features: Decentralized Governance: Dark Coin enables users to actively participate in shaping the project's future. Through our dApp, users can cast votes and submit proposals using NFT-based voting tokens. This allows the community to influence decisions on project direction, governance, and asset management. Character NFT Assets and AI Arena: Unique character NFT assets that can be engaged in battles within the Dark Coin AI Arena, providing an engaging and interactive experience for users. Governance and Control: The Dark Coin team is developing a user-friendly dApp accessible via (https://dark-coin.com), where members can participate in governance processes, propose changes, and vote on key decisions. Empowering the Community: Dark Coin is committed to empowering its community by providing the tools and mechanisms necessary for active participation, influence, and contribution. Through our DAO structure and decentralized governance, we strive to create a collaborative environment that benefits all members.",
            "Join us in shaping the future of decentralized finance on the Algorand network! Dark Coin is an experimental grassroots community project focused on expanding the Algorand DeFi ecosystem. Managed by a decentralized autonomous organization (DAO), Dark Coin's users collectively own and manage the project based on blockchain-enforced rules and smart contracts. The Council is an app integrated with Dark Coin, designed to let users vote on proposals using their DAO NFTs. It involves creating proposals, amending them, and voting to decide their fate. Anyone can create a proposal by sending 20 Algo to the Council smart contract. Once this is done, a separate contract is made for the specific proposal, which holds the 20 Algo.",
            "The Arena is a Dark Coin application where users can battle using their Dark Coin champion NFTs for fame, glory, and Dark Coin rewards. Dark Coin champion NFTs use Algorand's ARC-19 standard, allowing for swappable traits. Visit the trait swapper inside the Arena to mix and match the look of your champion. Equipped traits are sent to a contract for holding. Unequipped traits are sent to the user's wallet. When ready for battle, go to the select tab inside the Arena. Select the champion you wish to use in the battle. Start a new battle. Join a Battle: Join an already initialized battle. Both parties must pay a 10,000 Dark Coin wager plus an additional 0.1 Algo fee. When a champion joins an existing battle, the Arena contract determines the winner. The winner receives the combined 20,000 Dark Coin wager. Using AI, the app generates a battle story describing the victory. The app also creates an image depicting the two champions in battle. Battle results are displayed in a dedicated Discord channel.",
        ]     

        let darkCoin = "These are details about Dark Coin: " + darkCoinDetails[Math.floor(Math.random() * 3)]

        console.log("count: " + String(count))

        let responseEvent = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
            {
                role: "user",
                content: [
                  { 
                    type: "text", 
                    text: "Create a one sentence story based on what you see in the provided image. Make sure the story relates to what is happening in the image. Relate the story to what has happened before, but return a new one sentence addition to the story. Only return one sentence. Begin each section of the story differently with a new sentence structure than the previous story. Each story should relate to the decentralized currecy: Dark Coin. The past story was : " + prevStory
                  },
                  {
                      type: "image_url",
                      image_url: {
                      "url": urls[count],
                      },
                  },
                    
                    
                ],
            },
            ],
            temperature: 0.5
        });

        console.log(responseEvent.choices[0].message.content)

        let chat = responseEvent.choices[0].message.content

        prevStory = chat

        // let allVoices = ["onyx"]
    
        // let dialogue = {
        //     "line": chat,
        //     "voice": allVoices[Math.floor(Math.random() * allVoices.length)]
        // }

        // console.log(dialogue)

        // let speechFile = path.resolve("audio/cast" + String(count) + ".mp3");

        // if (count > 0) {
        //     fs.appendFile('./audiolist.txt', "file audio/cast" + String(count) + ".mp3" + "\n", err => {
        //         if (err) {
        //             console.error(err);
        //         } else {
        //             // file written successfully
        //         }
        //         });
        // }
        // else {
        //     fs.writeFile('./audiolist.txt', "file audio/cast" + String(count) + ".mp3" + "\n", err => {
        //         if (err) {
        //             console.error(err);
        //         } else {
        //             // file written successfully
        //         }
        //         });
        // }
    
        // let mp3 = await openai.audio.speech.create({
        //     model: "tts-1",
        //     voice: dialogue.voice,
        //     input: dialogue.line,
        // });
        // let buffer = Buffer.from(await mp3.arrayBuffer());
        // console.log(speechFile)
        // await fs.promises.writeFile(speechFile, buffer);

        const responseImage = await openai.images.generate({
          model: "dall-e-3",
          prompt: chat + " The style of the image should look realisitic, like a picture from reality. All friendly characters should be dressed in blue garb.",
          n: 1,
          size: "1792x1024",
        });

        console.log(responseImage)
    
        const genUrl = responseImage.data[0].url;

        const file = fs.createWriteStream("./extras/" + String(count * 30) + ".png");
        https.get(genUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log('Download completed!');

            
            
        });
        }).on('error', (err) => {
        fs.unlinkSync("./extras/" + String((count + 1) * 30) + ".png");
        console.error('Error downloading the file:', err.message);
        });

        count++
        
      }

      console.log(stories)

 


    } catch (error) {
      console.error("Error listing images:", error);
    }

}

const uploadStoryImages = async () => {
  try {

    let count = 1

    getFilenamesInDir('./images')
        .then(async (filenames) => {
          console.log('Filenames in myFolder:', filenames);
          // `filenames` is your array of files
          filenames.forEach((file) => {

            fs.readFile("./images/" + file, (err, data) => {
              if (err) {
                  console.error('Error reading file:', err);
                  return;
              }
  
              // 'data' is a Buffer instance, representing raw bytes
              console.log('Buffer:', data);
              console.log('Buffer length (bytes):', data.length);
              
              // If you want a typed array:
              const uint8Array = new Uint8Array(data);
              console.log('Uint8Array:', uint8Array);
  
              // Create a storage reference
              const storageRef = ref(storage, `gens/` + file);
  
              // Start the upload
              const uploadTask = uploadBytesResumable(storageRef, data);
  
              // Listen for state changes
              uploadTask.on(
              "state_changed",
              (snapshot) => {
                  // Compute progress
                  const progress =
                  (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
              console.log(progress)
              },
              (error) => {
                  console.error("Upload failed:", error);
                  alert("Upload failed, see console for details");
              },
              async () => {
                  // Upload completed successfully, get download URL
                  const url = await getDownloadURL(uploadTask.snapshot.ref);
                  console.log(url)
          
                  
  
              }
              );
              });

          })
          
    
    
        })
          console.log('Done!');

  } catch (error) {
    console.error("Error listing images:", error);
  }

}

const urlsVideo = async () => {
    try {

        // 1) Create a reference to the folder
        const folderUploadsRef = ref(storage, "uploads/");

        // 2) List all items (files) in that folder
        const resultUploads = await listAll(folderUploadsRef);

        // 3) For each item, get the download URL
        const urlUploadsPromises = resultUploads.items.map((itemRef) => getDownloadURL(itemRef));
        let urlsUploads = await Promise.all(urlUploadsPromises);

        function getSecondNumber(str) {
        const matches = str.match(/\d+/g); // all digit sequences
        if (matches && matches.length >= 2) {
            return parseInt(matches[4], 10); // second match
        }
        return Infinity; // fallback if second number doesn't exist
        }
        
        // Sort using the second number
        urlsUploads.sort((a, b) => {
        return getSecondNumber(a) - getSecondNumber(b);
        });

        urlsUploads = urlsUploads.slice(1)

      // 1) Create a reference to the folder
      const folderRef = ref(storage, "gens/");

      // 2) List all items (files) in that folder
      const result = await listAll(folderRef);

      // 3) For each item, get the download URL
      const urlPromises = result.items.map((itemRef) => getDownloadURL(itemRef));
      const urls = await Promise.all(urlPromises);
      
      // Sort using the first number
      urls.sort((a, b) => {
        return getSecondNumber(a) - getSecondNumber(b);
      });

      let count = 0 

      console.log(urls)
      console.log(urlsUploads)

      while (count < urls.length) {

        let generation = await client.generations.create({
            prompt: "camera zoom in",
            keyframes: {
                frame0: {
                    type: "image",
                    url: urlsUploads[count]
                },
                frame1: {
                    type: "image",
                    url: urls[count]
                }
            }
        });
    
        let completed = false;
    
        while (!completed) {
            generation = await client.generations.get(generation.id);
    
            if (generation.state === "completed") {
                completed = true;
            } else if (generation.state === "failed") {
                throw new Error(`Generation failed: ${generation.failure_reason}`);
            } else {
                console.log("Dreaming...");
                await new Promise(r => setTimeout(r, 3000)); // Wait for 3 seconds
            }
        }
    
        let videoUrl = generation.assets.video;
    
        let response = await fetch(videoUrl);
        let fileStream = fs.createWriteStream(`./begginings/${(count + 1) * 30}.mp4`);
        await new Promise((resolve, reject) => {
            response.body.pipe(fileStream);
            response.body.on('error', reject);
            fileStream.on('finish', resolve);
        });
    
        console.log(`File downloaded as ${(count + 1) * 30}.mp4`);

        generation = await client.generations.create({
            prompt: "camera zoom out",
            keyframes: {
                frame0: {
                  type: "generation",
                  id: generation.id
                }
            }
        });
    
        completed = false;
    
        while (!completed) {
            generation = await client.generations.get(generation.id);
    
            if (generation.state === "completed") {
                completed = true;
            } else if (generation.state === "failed") {
                throw new Error(`Generation failed: ${generation.failure_reason}`);
            } else {
                console.log("Dreaming...");
                await new Promise(r => setTimeout(r, 3000)); // Wait for 3 seconds
            }
        }
    
        videoUrl = generation.assets.video;
    
        response = await fetch(videoUrl);
        fileStream = fs.createWriteStream(`./extends/${(count + 1) * 30}.mp4`);
        await new Promise((resolve, reject) => {
            response.body.pipe(fileStream);
            response.body.on('error', reject);
            fileStream.on('finish', resolve);
        });
    
        console.log(`File downloaded as ${(count + 1) * 30}.mp4`);

        generation = await client.generations.create({
            prompt: "camera zoom out",
            keyframes: {
                frame0: {
                  type: "generation",
                  id: generation.id
                },
                frame1: {
                    type: "image",
                    url: urlsUploads[count]
                  }
            }
        });
    
        completed = false;
    
        while (!completed) {
            generation = await client.generations.get(generation.id);
    
            if (generation.state === "completed") {
                completed = true;
            } else if (generation.state === "failed") {
                throw new Error(`Generation failed: ${generation.failure_reason}`);
            } else {
                console.log("Dreaming...");
                await new Promise(r => setTimeout(r, 3000)); // Wait for 3 seconds
            }
        }
    
        videoUrl = generation.assets.video;
    
        response = await fetch(videoUrl);
        fileStream = fs.createWriteStream(`./ends/${(count + 1) * 30}.mp4`);
        await new Promise((resolve, reject) => {
            response.body.pipe(fileStream);
            response.body.on('error', reject);
            fileStream.on('finish', resolve);
        });
    
        console.log(`File downloaded as ${(count + 1) * 30}.mp4`);

        count++
        
      }

    } catch (error) {
      console.error("Error listing images:", error);
    }

}


const getAudioFromUrls = async () => {

    function getSecondNumber(str) {
        const matches = str.match(/\d+/g); // all digit sequences
        if (matches && matches.length >= 2) {
            return parseInt(matches[4], 10); // second match
        }
        return Infinity; // fallback if second number doesn't exist
    }

    let text = "The game is Age of Empires 2.  The player being shown is 'Dark Coin'. Create a story based on the first image going to the second. Just return the text of the story. Dark Coin is red color, his enemy is in the Blue color. "
    
    let darkCoinDetails = [
        "Dark Coin (ASA-1088771340) Dark Coin is an innovative community-driven project within the Algorand ecosystem, focused on expanding the possibilities of Algorand Standard Assets (ASAs) in the decentralized finance (DeFi) space. It operates as a decentralized autonomous organization (DAO), giving collective ownership and democratic management power to its members through blockchain-enforced rules. Key Features: Decentralized Governance: Dark Coin enables users to actively participate in shaping the project's future. Through our dApp, users can cast votes and submit proposals using NFT-based voting tokens. This allows the community to influence decisions on project direction, governance, and asset management. Character NFT Assets and AI Arena: Unique character NFT assets that can be engaged in battles within the Dark Coin AI Arena, providing an engaging and interactive experience for users. Governance and Control: The Dark Coin team is developing a user-friendly dApp accessible via (https://dark-coin.com), where members can participate in governance processes, propose changes, and vote on key decisions. Empowering the Community: Dark Coin is committed to empowering its community by providing the tools and mechanisms necessary for active participation, influence, and contribution. Through our DAO structure and decentralized governance, we strive to create a collaborative environment that benefits all members.",
        "Join us in shaping the future of decentralized finance on the Algorand network! Dark Coin is an experimental grassroots community project focused on expanding the Algorand DeFi ecosystem. Managed by a decentralized autonomous organization (DAO), Dark Coin's users collectively own and manage the project based on blockchain-enforced rules and smart contracts. The Council is an app integrated with Dark Coin, designed to let users vote on proposals using their DAO NFTs. It involves creating proposals, amending them, and voting to decide their fate. Anyone can create a proposal by sending 20 Algo to the Council smart contract. Once this is done, a separate contract is made for the specific proposal, which holds the 20 Algo.",
        "The Arena is a Dark Coin application where users can battle using their Dark Coin champion NFTs for fame, glory, and Dark Coin rewards. Dark Coin champion NFTs use Algorand's ARC-19 standard, allowing for swappable traits. Visit the trait swapper inside the Arena to mix and match the look of your champion. Equipped traits are sent to a contract for holding. Unequipped traits are sent to the user's wallet. When ready for battle, go to the select tab inside the Arena. Select the champion you wish to use in the battle. Start a new battle. Join a Battle: Join an already initialized battle. Both parties must pay a 10,000 Dark Coin wager plus an additional 0.1 Algo fee. When a champion joins an existing battle, the Arena contract determines the winner. The winner receives the combined 20,000 Dark Coin wager. Using AI, the app generates a battle story describing the victory. The app also creates an image depicting the two champions in battle. Battle results are displayed in a dedicated Discord channel.",
    ]     

    let darkCoin = "The monolouge should be about Dark Coin on the Algorand Blockchain, and the events happening in the image. Create the monolouge and relate it to the Dark Coin project."

    darkCoin = darkCoin + "These are details about Dark Coin: " + darkCoinDetails[Math.floor(Math.random() * 3)]

    // 1) Create a reference to the folder
    const folderRef = ref(storage, "gens/");

    // 2) List all items (files) in that folder
    const result = await listAll(folderRef);

    // 3) For each item, get the download URL
    const urlPromises = result.items.map((itemRef) => getDownloadURL(itemRef));
    const urls = await Promise.all(urlPromises);
    
    // Sort using the first number
    urls.sort((a, b) => {
      return getSecondNumber(a) - getSecondNumber(b);
    });

    let count = 0 

    console.log(urls)

    while (count < urls.length) {

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
            {
                role: "user",
                content: [
                    
                    {
                        type: "image_url",
                        image_url: {
                        "url": urls[count],
                        },
                    },
                    { 
                        type: "text", 
                        text: "Create an extremely short monolouge that is only 2 sentences long, that relates to what is happening in the image. Only return what the person says." + darkCoin
                    },
                    
                ],
            },
            ],
            });
    
            console.log(response.choices[0].message.content)
    
            let chat = response.choices[0].message.content
    
            let allVoices = ["alloy", "echo", "onyx", "fable", "nova", "shimmer"]
    
            let dialogue = {
                "line": chat,
                "voice": allVoices[Math.floor(Math.random() * allVoices.length)]
            }
    
            console.log(dialogue)
    
            let speechFile = path.resolve("audio/cast" + String(count) + ".mp3");
    
            if (count > 0) {
                fs.appendFile('./audiolist.txt', "file audio/cast" + String(count) + ".mp3" + "\n", err => {
                    if (err) {
                        console.error(err);
                    } else {
                        // file written successfully
                    }
                    });
            }
            else {
                fs.writeFile('./audiolist.txt', "file audio/cast" + String(count) + ".mp3" + "\n", err => {
                    if (err) {
                        console.error(err);
                    } else {
                        // file written successfully
                    }
                    });
            }
        
            let mp3 = await openai.audio.speech.create({
                model: "tts-1",
                voice: dialogue.voice,
                input: dialogue.line,
            });
            let buffer = Buffer.from(await mp3.arrayBuffer());
            console.log(speechFile)
            await fs.promises.writeFile(speechFile, buffer);
            count++

    }
  
}


function splitLongerVideo(inputPath, outputDir) {
    return new Promise(async (resolve, reject) => {
      try {

        function createArray(start, end, step) {
          const result = [];
          for (let i = start; i <= end; i += step) {
            result.push(i);
          }
          return result;
        }

        let insertionPoints = createArray(30, videoLength, 30)

        console.log(insertionPoints)

        const segments = [];

        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir);
        }
        const sortedPoints = [...insertionPoints].sort((a, b) => a - b);
  
        // Get total duration of the longer video
        const totalDuration = videoLength
  
        // e.g., if insertionPoints = [120, 300] => times = [0, 120, 300, totalDuration]
        const times = [0, ...sortedPoints, totalDuration];
  
        // Create each segment
        for (let i = 0; i < times.length - 1; i++) {
          const start = times[i];
          const duration = times[i + 1] - times[i];
          const segmentPath = path.join(outputDir, `segment${i + 1}.mp4`);
          segments.push(segmentPath);
  
          await new Promise((res, rej) => {
            ffmpeg(inputPath)
              .setStartTime(start)
              .setDuration(duration)
              .output(segmentPath)
              .on('end', () => {
                console.log(`Created segment: ${segmentPath}`);
                res();
              })
              .on('error', (err) => {
                console.error(`Error creating segment: ${segmentPath}`, err);
                rej(err);
              })
              .run();
          });
        }
  
        resolve(segments);
      } catch (err) {
        reject(err);
      }
    });
  }

function reencodeClip(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',
          '-preset veryfast',
          '-crf 23',
          // Force constant frame rate:
          '-vf scale=1280:720,fps=30',
          '-r 30',
          '-vsync cfr',
          
          '-c:a aac',
          '-b:a 128k',
          '-ac 2',
          '-ar 44100',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }

  async function reencodeFolder(srcFolder, dstFolder) {
    // Ensure destination folder exists
    if (!fs.existsSync(dstFolder)) {
      fs.mkdirSync(dstFolder);
    }
    
    const files = fs.readdirSync(srcFolder).filter(f => {
      const fullPath = path.join(srcFolder, f);
      return fs.statSync(fullPath).isFile();
    });
    
    for (const filename of files) {
      const inputPath = path.join(srcFolder, filename);
      // Maybe rename to something like .mp4 if original is .mov or .mkv
      const outputPath = path.join(dstFolder, path.parse(filename).name + '_reenc.mp4');
      try {
        console.log('Re-encoding:', inputPath);
        await reencodeClip(inputPath, outputPath);
        console.log('Done:', outputPath);
      } catch (err) {
        console.error('Error re-encoding', inputPath, err);
      }
    }
  }

  function addSilentAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        // Main video
        .input(inputPath)
        // Synthetic silent audio
        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions([
          '-f lavfi' // interpret the second input as a filter-based audio source
        ])
        .outputOptions([
          // Video encoding
          '-c:v libx264',
          '-preset veryfast',
          '-crf 23',
          '-pix_fmt yuv420p',
          '-vf scale=1280:720,fps=30',  // unify resolution & fps if needed
  
          // Audio encoding
          '-c:a aac',
          '-b:a 128k',
          '-ac 2',
          '-ar 44100',
          
          // Container flags
          '-movflags +faststart',
  
          // Stop the output when the shortest input ends (the video track)
          '-shortest'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }

  async function addSilentAudioToFolder(inputDir, outputDir) {
    // 1. Ensure the output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  
    // 2. Read all files from the inputDir
    const files = fs.readdirSync(inputDir);
  
    // 3. Filter for typical video file extensions (adjust as needed)
    const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
    const videoFiles = files.filter(file =>
      videoExtensions.includes(path.extname(file).toLowerCase())
    );
  
    // 4. Process each video file
    for (const file of videoFiles) {
      const inputFilePath = path.join(inputDir, file);
      // Output filename could match the original but appended or replaced extension
      const baseName = path.parse(file).name; // e.g. "clip1"
      const outputFilePath = path.join(outputDir, `${baseName}_silent.mp4`);
  
      console.log(`Adding silent audio to: ${file}`);
      try {
        await addSilentAudio(inputFilePath, outputFilePath);
        console.log(`=> Created: ${outputFilePath}`);
      } catch (err) {
        console.error(`Error processing ${file}:`, err);
      }
    }
  }
  
  

function interleaveClips(folder1, folder2, outputPath) {

    function getSecondNumber(str) {
        const matches = str.match(/\d+/g); // all digit sequences
        if (matches && matches.length >= 2) {
            return parseInt(matches[0], 10); // second match
        }
        return Infinity; // fallback if second number doesn't exist
    }

    // Collect all files from each folder
    let files1 = fs.readdirSync(folder1)
      .map(file => path.join(folder1, file))
      .filter(file => fs.statSync(file).isFile());
    let files2 = fs.readdirSync(folder2)
      .map(file => path.join(folder2, file))
      .filter(file => fs.statSync(file).isFile());

      files1.sort((a, b) => {
        return getSecondNumber(a) - getSecondNumber(b);
      });

      files2.sort((a, b) => {
        return getSecondNumber(a) - getSecondNumber(b);
      });

      console.log(files1)
      console.log(files2)
  
    // Interleave the files: one from folder1, one from folder2, etc.
    const combinedList = [];
    const max = Math.max(files1.length, files2.length);
    for (let i = 0; i < max; i++) {
      if (files1[i]) combinedList.push(files1[i]);
      if (files2[i]) combinedList.push(files2[i]);
    }
  
    // Create a temporary concat list file (using FFmpeg's concat demuxer syntax)
    const listFile = path.join(__dirname, 'concat_list.txt');
    const listContent = combinedList.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(listFile, listContent);
  
     // 4. Re-encode and concatenate using -f concat
    ffmpeg()
    .input(listFile)
    .inputOptions(['-f concat', '-safe 0'])
    // These output options will re-encode everything consistently
    .outputOptions(['-c copy'])
    .output(outputPath)
    .on('end', () => {
        console.log('Concatenation finished. Output file:', outputPath);
        fs.unlinkSync(listFile); // remove the temporary list
    })
    .on('error', err => {
        console.error('Error during concatenation:', err);
    })
    .run();
  }
  

  function getFilenamesInDir(dirPath) {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, (err, files) => {
        if (err) {
          return reject(err);
        }
        resolve(files); // `files` is already an array of filenames
      });
    });
  }

  function addMultipleAudioClipsToVideo(
    inputVideo,
    audioClips,
    outputVideo,
    includeOriginalAudio = true,
    volumeMultiplier = 4 // or any float/dB you desire
  ) {
    return new Promise((resolve, reject) => {
      const command = ffmpeg().input(inputVideo);
  
      // 1) Add each audio clip input
      audioClips.forEach((clip) => {
        command.input(clip.path);
      });
  
      // 2) Build the complex filter array
      const complexFilter = [];
      const amixInputsCount = includeOriginalAudio
        ? audioClips.length + 1 // (video audio + N audio clips)
        : audioClips.length;    // if skipping original audio
  
      // For each audio clip, delay it by (offset * 1000) ms
      audioClips.forEach((clip, index) => {
        const inputIndex = index + 1;  // main video = input #0, audio clips start at #1
        const delayMs = clip.offset * 1000;
        // e.g. [1]adelay=3000|3000[a0]
        complexFilter.push(`[${inputIndex}]adelay=${delayMs}|${delayMs}[a${index}]`);
      });
  
      // 3) Build the amix line
      let mixInputs = '';
  
      if (includeOriginalAudio) {
        // Start with the main video’s audio: [0:a]
        mixInputs += '[0:a]';
      }
  
      // Add each delayed clip label
      mixInputs += audioClips.map((_, i) => `[a${i}]`).join('');
  
      // e.g. "[0:a][a0][a1]amix=inputs=3:duration=longest[aout]"
      complexFilter.push(
        `${mixInputs}amix=inputs=${amixInputsCount}:duration=longest[aout]`
      );
  
      // 4) Apply a volume filter on the mixed output (make it 2x as loud, for example).
      //
      // If you prefer using dB notation, you can do something like volume='5dB':
      //   complexFilter.push('[aout]volume=5dB[aout2]');
      //
      // Using a multiplier (2 = +6dB approximately):
      complexFilter.push(`[aout]volume=${volumeMultiplier}[aout2]`);
  
      // 5) Set up ffmpeg mappings
      command
        .complexFilter(complexFilter)
        .outputOptions([
          // Keep original video track
          '-map 0:v',
          // Map the newly labeled audio stream with adjusted volume
          '-map [aout2]',
        ])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputVideo);
    });
  }

    //saveFrames()

    //uploadScreenshotImages()

    //ScreenshotToStory()

    //uploadStoryImages()

    //urlsVideo()

      //splitLongerVideo("aoe2.mp4", "segments")


      // (async () => {
      //   await reencodeFolder('./segments', './tempA');
      //   await reencodeFolder('./ends', './tempB');
      //   console.log('Re-encoding complete! Now ready to concatenate.');
      // })();


    //   (async () => {
    //     const inputFolder = path.join(__dirname, 'tempB');
    //     const outputFolder = path.join(__dirname, 'tempC');
      
    //     await addSilentAudioToFolder(inputFolder, outputFolder);
    //     console.log('All done!');
    //   })();


    //interleaveClips('./tempA', './tempC', 'final_merged.mp4');

  
    getFilenamesInDir('./audio')
      .then(async (filenames) => {
        console.log('Filenames in myFolder:', filenames);
        // `filenames` is your array of files
        let sortedFiles = filenames.sort((a, b) => {
          // Match the first sequence of digits in each string
          const matchA = a.match(/\d+/);
          const matchB = b.match(/\d+/);
        
          // If a string has no digits, decide how you want to handle it
          // For example, treat it as zero or move it to the end:
          const numA = matchA ? parseInt(matchA[0], 10) : Number.NEGATIVE_INFINITY;
          const numB = matchB ? parseInt(matchB[0], 10) : Number.NEGATIVE_INFINITY;
        
          return numA - numB;
        });
        console.log(sortedFiles)
        let offset = 30
        let finalFiles = []
        sortedFiles.forEach((file) => {
          finalFiles.push({path: "audio/" + file, offset: offset})
          offset = offset + 42.5
        })
        addMultipleAudioClipsToVideo('final_merged.mp4', finalFiles, 'outputFinal.mp4')
        .then(() => {
          console.log('Processing finished successfully!');
        })
        .catch((err) => {
          console.error('Error:', err);
        });
  
  
      })
        console.log('Done!');




