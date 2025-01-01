import Jimp from "jimp"
import fs from "fs";
import OpenAI from "openai";


import ffmpegPath from "@ffmpeg-installer/ffmpeg"
import ffmpeg from "fluent-ffmpeg"

import path from "path";
import { timeStamp } from "console";
import { stringify } from "querystring";

import readline from "readline"

ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);


// Dark Coin (ASA-1088771340) Dark Coin is an innovative community-driven project within the Algorand ecosystem, focused on expanding the possibilities of Algorand Standard Assets (ASAs) in the decentralized finance (DeFi) space. It operates as a decentralized autonomous organization (DAO), giving collective ownership and democratic management power to its members through blockchain-enforced rules.

// The goal of this channel is to talk and educate the viewer about Dark Coin, in a video game like environment. 

// Viewers should do their own research when investing into digital currencies. THIS VIDEO SHOULD NOT BE TAKEN AS FINACIAL ADVICE.

// Discord
// https://discord.gg/FxAyHQDh

// Website
// https://dark-coin.io/

// DAPP
// https://dark-coin.com/

// DAO NFT'S
// https://algoxnft.com/collection/dark-...

// Champion NFT'S
// https://algoxnft.com/collection/dark-...
// https://www.randgallery.com/collectio...
// https://www.asalytic.app/collection/d...

// Champion Trait NFT'S
// https://algoxnft.com/collection/dark-...
// https://www.randgallery.com/collectio...

// Pera Explorer (Dark Coin ASA)
// https://explorer.perawallet.app/asset...

// Vestige Chart (Dark Coin ASA)
// https://vestige.fi/asset/1088771340

// Tinyman swap (Algo to DC)
// https://app.tinyman.org/#/swap?asset_...

// Tinyman LP Pool (Dark Coin ASA)
// https://app.tinyman.org/#/pool/56XJVR...

// Reddit link
// https://www.reddit.com/r/DarkCoinASA/


ffmpeg.setFfmpegPath(ffmpegPath.path);


var video = new ffmpeg('aoe2.mp4')

const openai = new OpenAI({
    apiKey: "sk-"
});


let videoLength = 1064
let pastStories = []
let count = 0

let inputFiles = []

let segments = []





function saveFrames() {
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
            timestamps: Array.from({ length: Math.floor(videoLength / 30) }, (_, i) => i * 30),
            filename: 'thumbnail-at-%s-seconds.png',
            folder: "screenshots",
            size: '1280x720'
        });
    });
  }

  function getVideoAndAudio() {

        return new Promise(async (resolve) => {

            console.log(count)
            const image1 = await Jimp.read('screenshots/thumbnail-at-' + String(count) + '-seconds.png');
            const image2 = await Jimp.read('screenshots/thumbnail-at-' + String(count + 30) + '-seconds.png');


            
            image1.getBase64Async(Jimp.MIME_PNG).then(async (base641) => {
                image2.getBase64Async(Jimp.MIME_PNG).then(async (base642) => {


                //let history = " This is an ongoing story, do not introduce the scene. Tell the next part of the story based on the defference between the first image and the second. The previous parts are: " + pastStories.toString() + " try to talk about a different aspect of Dark Coin than what was previous stated."
                function getFolderNames(directoryPath) {
                    const items = fs.readdirSync(directoryPath);
                  
                    const folderNames = items.filter(item => {
                      const fullPath = path.join(directoryPath, item);
                      return fs.statSync(fullPath).isDirectory();
                    });
                  
                    return folderNames;
                  }
                  
                  const folderPath = './videos'; // Replace with the path to your folder
                  const folderNames = getFolderNames(folderPath);
                  
                  console.log(folderNames);
            
                
                
                
                const response = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                    {
                        role: "user",
                        content: [
                            
                            {
                                type: "image_url",
                                image_url: {
                                "url": base641,
                                },
                            },
                            {
                                type: "image_url",
                                image_url: {
                                "url": base642,
                                },
                            },
                            { 
                                type: "text", 
                                text: "Based on what is happening from the first image to the second image, choose one of these categories it mosts relates to: " + folderNames.toString() + " Return only the category chosen."
                            },
                            
                        ],
                    },
                    ],
                    });

                    console.log(response.choices[0].message.content)

                    let folder = response.choices[0].message.content

                    const directoryPath = './videos/' + folder; // Replace with the actual path

                    fs.readdir(directoryPath, (err, files) => {
                    if (err) {
                        console.error('Error reading directory:', err);
                        return;
                    }

                    console.log('Files in the directory:', files);

                    const videoFolderPath = './videos/' + folder; // Replace with your folder path
                    const videoFileName = files[Math.floor(Math.random() * files.length)]; // Replace with your video file name

                    const videoPath = path.join(videoFolderPath, videoFileName);

                    if (count > 0) {
                      fs.appendFile('./videolist.txt', videoPath + "\n", err => {
                        if (err) {
                          console.error(err);
                        } else {
                          // file written successfully
                        }
                      });
                    }
                    else {
                      fs.appendFile('./videolist.txt', videoPath + "\n", err => {
                        if (err) {
                          console.error(err);
                        } else {
                          // file written successfully
                        }
                      });
                    }

                    let scene = new ffmpeg(videoPath)

                    return new Promise(async (resolve) => {
                        await scene
                        .on('filenames', function(filenames) {
                            console.log('Screenshots are being saved as: ' + filenames.join(', '));
                        })
                        .on('end', async function() {
                            console.log('Screenshots taken');

                            const image = await Jimp.read('tempss/thumbnail-at-5-seconds.png');

                            image.getBase64Async(Jimp.MIME_PNG).then(async (base64) => {

                                let text = "The game is Age of Empires 2.  The player being shown is 'Dark Coin'. Create a story based on the first image going to the second. Just return the text of the story. Dark Coin is red color, his enemy is in the Blue color. "

                                let darkCoinDetails = [
                                    "Dark Coin (ASA-1088771340) Dark Coin is an innovative community-driven project within the Algorand ecosystem, focused on expanding the possibilities of Algorand Standard Assets (ASAs) in the decentralized finance (DeFi) space. It operates as a decentralized autonomous organization (DAO), giving collective ownership and democratic management power to its members through blockchain-enforced rules. Key Features: Decentralized Governance: Dark Coin enables users to actively participate in shaping the project's future. Through our dApp, users can cast votes and submit proposals using NFT-based voting tokens. This allows the community to influence decisions on project direction, governance, and asset management. Character NFT Assets and AI Arena: Unique character NFT assets that can be engaged in battles within the Dark Coin AI Arena, providing an engaging and interactive experience for users. Governance and Control: The Dark Coin team is developing a user-friendly dApp accessible via (https://dark-coin.com), where members can participate in governance processes, propose changes, and vote on key decisions. Empowering the Community: Dark Coin is committed to empowering its community by providing the tools and mechanisms necessary for active participation, influence, and contribution. Through our DAO structure and decentralized governance, we strive to create a collaborative environment that benefits all members.",
                                    "Join us in shaping the future of decentralized finance on the Algorand network! Dark Coin is an experimental grassroots community project focused on expanding the Algorand DeFi ecosystem. Managed by a decentralized autonomous organization (DAO), Dark Coin's users collectively own and manage the project based on blockchain-enforced rules and smart contracts. The Council is an app integrated with Dark Coin, designed to let users vote on proposals using their DAO NFTs. It involves creating proposals, amending them, and voting to decide their fate. Anyone can create a proposal by sending 20 Algo to the Council smart contract. Once this is done, a separate contract is made for the specific proposal, which holds the 20 Algo.",
                                    "The Arena is a Dark Coin application where users can battle using their Dark Coin champion NFTs for fame, glory, and Dark Coin rewards. Dark Coin champion NFTs use Algorand's ARC-19 standard, allowing for swappable traits. Visit the trait swapper inside the Arena to mix and match the look of your champion. Equipped traits are sent to a contract for holding. Unequipped traits are sent to the user's wallet. When ready for battle, go to the select tab inside the Arena. Select the champion you wish to use in the battle. Start a new battle. Join a Battle: Join an already initialized battle. Both parties must pay a 10,000 Dark Coin wager plus an additional 0.1 Algo fee. When a champion joins an existing battle, the Arena contract determines the winner. The winner receives the combined 20,000 Dark Coin wager. Using AI, the app generates a battle story describing the victory. The app also creates an image depicting the two champions in battle. Battle results are displayed in a dedicated Discord channel.",
                                ]     

                                let darkCoin = "The monolouge should be about Dark Coin on the Algorand Blockchain, and the events happening in the image. Create the monolouge and relate it to the Dark Coin project."

                                darkCoin = darkCoin + "These are details about Dark Coin: " + darkCoinDetails[Math.floor(Math.random() * 3)]


                                const response = await openai.chat.completions.create({
                                    model: "gpt-4o-mini",
                                    messages: [
                                    {
                                        role: "user",
                                        content: [
                                            
                                            {
                                                type: "image_url",
                                                image_url: {
                                                "url": base64,
                                                },
                                            },
                                            { 
                                                type: "text", 
                                                text: "Create an extremely short monolouge that is only 2 sentences long, spoken from one of the people in the image. Only return what the person says." + darkCoin 
                                            },
                                            
                                        ],
                                    },
                                    ],
                                    });
                
                                    console.log(response.choices[0].message.content)

                                    let chat = response.choices[0].message.content

                                    let maleVoices = ["alloy", "echo", "onyx", "fable"]

                                    let dialogue =  [
                                        {
                                        "line": chat,
                                        "voice": maleVoices[Math.floor(Math.random() * maleVoices.length)]
                                        }
                                       
                                          
                                    ]

                                    console.log(dialogue)

                                    dialogue.forEach(async (dia, index) => {

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
                                            voice: dia.voice,
                                            input: dia.line,
                                        });
                                        let buffer = Buffer.from(await mp3.arrayBuffer());
                                        console.log(speechFile)
                                        await fs.promises.writeFile(speechFile, buffer);
                                        count = count + 30
                                        segments.push(count)
                                        console.log(segments)
                                        await getVideoAndAudio()           
                                        
                                    
                                    })
                                    

                                //     let jsonExample = {
                            
                                //         "dialogue": [
                                //           {
                                //             "speaker": "Narrator",
                                //             "line": "As Dark Coin scouted the landscape, he encountered a group of villagers.",
                                //             "voice": "fable"
                                //           },
                                //           {
                                //             "speaker": "Ivan",
                                //             "line": "Do you see how Dark Coin shapes our future? With decentralized governance, every voice matters!",
                                //             "gender": "must be either male or female"
                                //           },
                                //           {
                                //             "speaker": "Narrator",
                                //             "line": "Ivan exclaimed, peering at the map.",
                                //             "voice": "fable"
                                //           },
                                //           {
                                //             "speaker": "Mila",
                                //             "line": "Exactly! We can vote on proposals and truly own our project. It’s democracy on the Algorand Blockchain!",
                                //             "gender": "must be either male or female"
                                //           },
                                //           {
                                //             "speaker": "Narrator",
                                //             "line": "Mila adjusted the pickaxe on her shoulder.",
                                //             "voice": "fable"
                                //           },
                                //           {
                                //             "speaker": "Ivan",
                                //             "line": "That’s the power of community! Join us, and let’s forge a thriving ecosystem together!",
                                //             "gender": "must be either male or female"
                                //           },
                                //           {
                                //             "speaker": "Narrator",
                                //             "line": "Ivan added, his excitement palpable.",
                                //             "voice": "fable"
                                //           }
                                //         ],
                                //         "scene": "describe the scene of this dialoge"
                                      
            
                                //   }
            
                                // const responseObject = await openai.chat.completions.create({
                                //     model: "gpt-4o-mini",
                                //     response_format: { type: "json_object" },
                                //     messages: [
                                //     {
                                //         role: "user",
                                //         content: [
                                //             { 
                                //                 type: "text", 
                                //                 text: chat
                                //             },
                                //             { 
                                //                 type: "text", 
                                //                 text: "return a JSON object in this example structure: " + JSON.stringify(jsonExample) + "but use the story from the input. For the voice key, pick one of the options for male and female names. "
                                //             },   
                                            
                                //         ],
                                //     },
                                //     ],
                                //     });
            
                                
            
                                // let dialogue = JSON.parse(responseObject.choices[0].message.content)
            
                                // console.log(dialogue)
            
                               
            
                                // let maleVoices = ["alloy", "echo", "onyx"]
                                // let femaleVoices = ["nova", "shimmer"]
            
                                // dialogue["dialogue"].forEach(async (dia, index) => {
                                //     if (dia.gender == "male") {
                                //         dialogue["dialogue"][index].voice = maleVoices[Math.floor(Math.random() * 3)]
            
                                //     }
                                //     else if (dia.gender == "female") {
                                //         dialogue["dialogue"][index].voice = femaleVoices[Math.floor(Math.random() * 2)]
                                //     }
                                // })
            
                                // let nameObject = {
            
                                // }
            
                                // dialogue["dialogue"].forEach(async (dia, index) => {
                                //     console.log(dia)
                                //     if (nameObject[dia.speaker]) {
                                //         dialogue["dialogue"][index].voice = nameObject[dia.speaker]
            
                                //     }
                                //     else {
                                //         nameObject[dia.speaker] = dia.voice
                                //     }
                                // })
            
                                // inputFiles = []

                                // const stichAudio = async () => {
                                //     return new Promise(async (resolve) => {
                                
                                //         console.log(inputFiles)
                                //         console.log("here")
                                
                                //         const fileContent = inputFiles.map(file => `file '${file}'`).join('\n');
                                
                                //         let id = Math.floor(Math.random() * 10000)
                                //                     console.log(fileContent)
                                //                     fs.writeFileSync('filelist.txt', fileContent);
                                                    
                                //                     // Concatenate the audio files using ffmpeg
                                //                     ffmpeg()
                                //                       .input('filelist.txt')
                                //                       .inputOptions('-f concat')
                                //                       .inputOption('-safe 0')
                                //                       .outputOptions('-c copy')
                                //                       .on('error', function(err) {
                                //                         console.error('An error occurred: ' + err.message);
                                //                       })
                                //                       .on('end', function() {
                                //                         console.log('Files have been concatenated successfully.');
                                //                         // Clean up temporary file
                                //                         resolve()
                                //                       })
                                //                       .save("final" + count + ".mp3");
                                
                                        
                                        
                                //     })
                                // }
            
                                // await dialogue["dialogue"].forEach(async (dia, index) => {
            
                                //     let speechFile = path.resolve("cast" + String(index) + ".mp3");
            
                                //     let mp3 = await openai.audio.speech.create({
                                //         model: "tts-1",
                                //         voice: dia.voice,
                                //         input: dia.line,
                                //     });
                                //     let buffer = Buffer.from(await mp3.arrayBuffer());
                                //     await fs.promises.writeFile(speechFile, buffer);
            
                                //     inputFiles.push("cast" + String(index) + ".mp3")
            
                                //     if (inputFiles.length == dialogue["dialogue"].length) {
                                //         inputFiles.sort((a, b) => {
                                //             const numA = parseInt(a.match(/(\d+)\.mp3$/)[1], 10);
                                //             const numB = parseInt(b.match(/(\d+)\.mp3$/)[1], 10);
                                //             return numA - numB;
                                //           });
                                //           await stichAudio()
                                //           count = count + 30
                                //           if (videoLength - count > 0) {
                                //             generateAudio()
                                //           }
                                //     }
            
                                // })
            
                                
            
                            })


                        })
                        .on('error', function(err) {
                            console.error('An error occurred: ' + err.message);
                        })
                        .screenshots({
                            timestamps: Array.from({ length: 1 }, (_, i) => 5),
                            filename: 'thumbnail-at-%s-seconds.png',
                            folder: "tempss",
                            size: '1280x720'
                        });
                    });

                    });

                    

                    
                      
                    

                
            })
        })
        
        });

        
    
  }

  

  function stichVideo() {
    return new Promise(async (resolve) => {

        const videoFiles = [];

        fs.readdirSync("final").forEach(file => {
            videoFiles.push(file)
        })

        videoFiles.sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0]);
            const numB = parseInt(b.match(/\d+/)[0]);
            return numA - numB;
          });

        console.log(videoFiles)

     
        fs.writeFileSync('filelist.txt', videoFiles.map(file => `file 'final/${file}'`).join('\n'));

        ffmpeg()
        .input('filelist.txt')
        .inputFormat('concat')
        .inputOption('-safe 0')
        .outputOptions('-c copy')
        .on('end', () => {
            console.log('Files have been merged successfully');
            
        })
        .on('error', (err) => {
            console.error('Error merging files:', err);
        })
        .save('output.mp4');

        
        
    })
}

const createAudio = async () => {
  return new Promise(async (resolve) => {

    let maleVoices = ["alloy", "echo", "onyx", "fable"]
    let femaleVoices = ["nova", "shimmer"]

    let allVoices = ["alloy", "echo", "onyx", "fable", "nova", "shimmer"]

    let randomVoice1 = maleVoices[Math.floor(Math.random() * maleVoices.length)]

    let randomVoice2 = allVoices[((Math.floor(Math.random() * allVoices.length)) + 1) % 4]

    // {
    //   "line": <line here>, 
    //   "voice": randomVoice1
    // },
    // {
    //   "line": <line here>, 
    //   "voice": randomVoice2 
    // },
    // {
    //   "line": <line here>, 
    //   "voice": randomVoice1
    // },
    // {
    //   "line": <line here>, 
    //   "voice": randomVoice2
    // },
    // }

    // I want to break this conversation into multiple sections, with a few points per section. The beginning should be about changing the conversation on crypto away from the price and institutional adoption, because ultimately the best kind of financial system is one that is not largely controlled by a small number of people. 

    let dialogue =  [
        {
        "line": "Changing the conversation around cryptocurrency from its price volatility to its technological potential requires a shift in focus toward the transformative capabilities of blockchain, smart contracts, and decentralized systems. Here's how this can be reframed:",
        "voice": "onyx"
        },
        {
        "line": "Emphasizing Real-World Use Cases Over Speculation",
        "voice": "nova"
        },
          
        ]



inputFiles = []

dialogue.forEach(async (dia, index) => {

    let speechFile = path.resolve("cast" + String(index) + ".mp3");

    let mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: dia.voice,
        input: dia.line,
    });
    let buffer = Buffer.from(await mp3.arrayBuffer());
    console.log(speechFile)
    await fs.promises.writeFile(speechFile, buffer);

    inputFiles.push(speechFile)

    if (inputFiles.length == dialogue.length) {
      console.log("here")
        inputFiles.sort((a, b) => {
            const numA = parseInt(a.match(/(\d+)\.mp3$/)[1], 10);
            const numB = parseInt(b.match(/(\d+)\.mp3$/)[1], 10);
            return numA - numB;
          });
        resolve()
    }

})

})

}

function splitLongerVideo(inputPath, insertionPoints, outputDir) {
    return new Promise(async (resolve, reject) => {
      try {
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

  /**
 * Retrieves the duration (in seconds) of a video/audio file using ffprobe.
 * @param {string} filePath - Path to the video/audio file.
 * @returns {Promise<number>} - Resolves with the duration in seconds.
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      // 'metadata.format.duration' gives the duration in seconds
      const durationInSeconds = metadata.format.duration;
      resolve(durationInSeconds);
    });
  });
}

  /**
 * Concatenate all segments and short videos into the final output.
 */
function overlayVideo(mainVideo, overlayClip, index) {
  return new Promise((resolve, reject) => {

    (async () => {
      try {
        const duration = await getDuration(overlayClip);
        console.log(`Duration: ${duration} seconds`);

        // Overlay from t=10s to t=15s
        const startTime = 0;
        const overlayDuration = duration;  // so it ends at t=15

        ffmpeg()
          // 0: main, 1: overlay
          .input(mainVideo)
          .input(overlayClip)

          // Build a filter graph that overlays the second video on the first
          .complexFilter([
            {
              filter: 'scale',
              options: {
                w: '640',
                h: '360',
                force_original_aspect_ratio: 'decrease'
                // Alternatively: force_original_aspect_ratio='decrease' or w=640, h=-1, etc.
              },
              inputs: '1:v',
              outputs: 'scaled_overlay'
            },
            {
              filter: 'fade',
              options: {
                t: 'in',
                st: 0,
                d: 1,
                alpha: 1  // crucial for alpha fading
              },
              inputs: 'scaled_overlay',
              outputs: 'overlay_faded_in'
            },
            // 2) Fade out from t=4..5 (last second). 
            //    t='out', st=4, d=1 => fade out from second 4 to 5
            {
              filter: 'fade',
              options: {
                t: 'out',
                st: duration - 1,
                d: 1,
                alpha: 1
              },
              inputs: 'overlay_faded_in',
              outputs: 'overlay_faded'
            },
            // 3) Overlay the fully alpha-animated clip onto the main from t=10..15
            {
              filter: 'overlay',
              options: {
                x: 100 * Math.floor(Math.random() * 10 + 1),
                y: 100 * Math.floor(Math.random() * 6 + 1),
                //enable: 'between(t,10,15)' // only show overlay from main t=10s..15s
              },
              inputs: ['0:v', 'overlay_faded'],
              outputs: 'vout'
            }
          ])
        
          // Audio: we’ll just keep the main audio (map 0:a).
          // If you want the overlay audio to fade in/out too, see below.
          .outputOptions([
            '-map [vout]', // the final composited video
            '-map 0:a?',   // main audio track if present (the "?" prevents error if there's none)
            '-c:v libx264', 
            '-pix_fmt yuv420p', // ensure broad compatibility
            '-c:a aac',
            '-shortest'
          ])
          .on('start', cmd => console.log('FFmpeg Command:', cmd))
          .on('error', (err) => console.error('Error:', err))
          .on('end', () => console.log('Done! Check output' + String(index) + '.mp4'))
          .save('output/output' + String(index) + '.mp4');
          resolve()

      } catch (error) {
        console.error('Error getting duration:', error);
      }
    })();

    
  });
}

  //await getVideoAndAudio()

//   splitLongerVideo("aoe2.mp4", [
//     30,  60,  90, 120, 150,  180, 210,
//    240, 270, 300, 330, 360,  390, 420,
//    450, 480, 510, 540, 570,  600, 630,
//    660, 690, 720, 750, 780,  810, 840,
//    870, 900, 930, 960, 990, 1020
//  ], "segments")

/**
 * Reads a file line by line and adds each line to an array.
 * @param {string} filePath - The path to the file to read.
 * @returns {Promise<string[]>} - A promise that resolves to an array of lines.
 */
function readFileLines(filePath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const lines = [];

    // Read each line
    rl.on('line', (line) => {
      console.log(line)
      lines.push(line);
    });

    // Handle errors
    fileStream.on('error', (err) => {
      reject(err);
    });

    // When the file has been fully read
    rl.on('close', () => {
      console.log(lines)
      resolve(lines);
    });
  });
}

/**
 * Asynchronously gets all filenames in a given directory and returns them in an array.
 * @param {string} dirPath - The path to the directory.
 * @returns {Promise<string[]>} - A promise that resolves to an array of filenames.
 */
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

async function sleep(msec) {
  return new Promise(resolve => setTimeout(resolve, msec));
}

// Example usage:
// (async () => {
//   try {
//     const linesArray = await readFileLines('videolist.txt');
//     console.log('All lines:', linesArray);
//     getFilenamesInDir('./segments')
//     .then(async (filenames) => {
//       console.log('Filenames in myFolder:', filenames);
//       // `filenames` is your array of files
//       let sortedFiles = filenames.sort((a, b) => {
//         // Match the first sequence of digits in each string
//         const matchA = a.match(/\d+/);
//         const matchB = b.match(/\d+/);
      
//         // If a string has no digits, decide how you want to handle it
//         // For example, treat it as zero or move it to the end:
//         const numA = matchA ? parseInt(matchA[0], 10) : Number.NEGATIVE_INFINITY;
//         const numB = matchB ? parseInt(matchB[0], 10) : Number.NEGATIVE_INFINITY;
      
//         return numA - numB;
//       });
//       console.log(sortedFiles)
//       let num = 0
//       while(num < sortedFiles.length) {
//         let overlay = linesArray[num].replace(/\/\/+/g, '/');
//         console.log(overlay)
//         await overlayVideo("segments/" + sortedFiles[num], overlay, num)
//         await sleep(5000)
//         num++
//       }
//     })
//     .catch((error) => {
//       console.error('Error reading directory:', error);
//     });
//   } catch (err) {
//     console.error('Error reading file:', err);
//   }
// })();

function mergeVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg();

    // Add each video as an input
    videoPaths.forEach((video) => {
      command = command.input("output/" + video);
    });

    command
      .on('error', (err) => {
        console.error('An error occurred:', err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Merging finished successfully!');
        resolve();
      })
      // This will merge the inputs in the order they were added
      .mergeToFile(outputPath);
  });
}

// (async () => {
//   try {
//     getFilenamesInDir('./output')
//     .then(async (filenames) => {
//       console.log('Filenames in myFolder:', filenames);
//       // `filenames` is your array of files
//       let sortedFiles = filenames.sort((a, b) => {
//         // Match the first sequence of digits in each string
//         const matchA = a.match(/\d+/);
//         const matchB = b.match(/\d+/);
      
//         // If a string has no digits, decide how you want to handle it
//         // For example, treat it as zero or move it to the end:
//         const numA = matchA ? parseInt(matchA[0], 10) : Number.NEGATIVE_INFINITY;
//         const numB = matchB ? parseInt(matchB[0], 10) : Number.NEGATIVE_INFINITY;
      
//         return numA - numB;
//       });
//       console.log(sortedFiles)
//       await mergeVideos(
//         sortedFiles,
//         'outputFull.mp4'
//       );
//       console.log('Done!');
//     })
    
//   } catch (err) {
//     console.error('Error merging videos:', err);
//   }
// })();

function addMultipleAudioClipsToVideo(
  inputVideo,
  audioClips,
  outputVideo,
  includeOriginalAudio = true
) {
  return new Promise((resolve, reject) => {
    // 1) Create the ffmpeg command
    const command = ffmpeg().input(inputVideo);

    // 2) Add each audio clip input
    audioClips.forEach((clip) => {
      command.input(clip.path);
    });

    // 3) Build the complex filter array
    const complexFilter = [];
    const amixInputsCount = includeOriginalAudio
      ? audioClips.length + 1 // (video audio + N audio clips)
      : audioClips.length;    // if skipping original audio

    // For each audio clip, delay it by (offset * 1000) ms
    audioClips.forEach((clip, index) => {
      // The main video is input #0, audio clips start at index + 1
      const inputIndex = index + 1;
      const delayMs = clip.offset * 1000; // seconds -> ms

      // e.g., "[1]adelay=3000|3000[a0]"
      // For stereo, we specify delay twice: "3000|3000"
      complexFilter.push(`[${inputIndex}]adelay=${delayMs}|${delayMs}[a${index}]`);
    });

    // Build the amix line. It could include the original video’s audio [0:a] if desired.
    let mixInputs = '';

    if (includeOriginalAudio) {
      // Start with the main video’s audio: [0:a]
      mixInputs += '[0:a]';
    }

    // Add each delayed clip label: [a0][a1][a2]...
    mixInputs += audioClips.map((_, i) => `[a${i}]`).join('');

    // e.g. "[0:a][a0][a1]amix=inputs=3:duration=longest[aout]"
    complexFilter.push(
      `${mixInputs}amix=inputs=${amixInputsCount}:duration=longest[aout]`
    );

    // 4) Apply complex filter and map
    command
      .complexFilter(complexFilter)
      .outputOptions([
        // Keep original video track
        '-map 0:v',
        // Use our mixed audio track
        '-map [aout]'
      ])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputVideo);
  });
}

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
      let offset = 0
      let finalFiles = []
      sortedFiles.forEach((file) => {
        finalFiles.push({path: "audio/" + file, offset: offset + 1})
        offset = offset + 30
      })
      addMultipleAudioClipsToVideo('outputFull.mp4', finalFiles, 'outputFinal.mp4')
      .then(() => {
        console.log('Processing finished successfully!');
      })
      .catch((err) => {
        console.error('Error:', err);
      });


    })
      console.log('Done!');
    

