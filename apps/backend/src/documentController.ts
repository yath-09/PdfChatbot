// src/controllers/documentController.ts

import { Request, Response } from 'express';
import { OpenAIEmbeddings } from "@langchain/openai";
import { PDFProcessingService } from '../src/pdfService';
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import crypto from 'crypto';
import {prismaClient} from "db"

const pdfService = new PDFProcessingService();

// Initialize embeddings service
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY!,
  modelName: "text-embedding-ada-002",
});

export class DocumentController {
  /**
   * Handle text embedding requests
   * Splits long text into chunks and embeds each chunk separately
   */
  async embedText(req: Request, res: Response, pineconeClient: any) {
    try {
      const { text, id, metadata = {} } = req.body;
      
      // Validate required fields
      if (!text || !id) {
        return res.status(400).json({ error: "Text & ID required" });
      }
      
      // Check if Pinecone client is initialized
      if (!pineconeClient) {
        return res.status(503).json({ error: "Database not yet initialized" });
      }
      
      // For long texts, split into chunks
      // Create a text splitter with specific configuration
      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000, // Size of each chunk in characters
        chunkOverlap: 200, // Overlap between chunks to maintain context
      });
      
      // Split the text into chunks
      const chunks = await textSplitter.createDocuments([text]);
      console.log(`Split text into ${chunks.length} chunks`);
      
      // Get the index from Pinecone
      const index = pineconeClient.Index(process.env.PINECONE_INDEX!);
      
      // Store each chunk in database and Pinecone
      const storedChunks = [];
      
      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Generate a unique ID for this chunk
        const chunkId = `text-${id}-chunk-${i}-${crypto.randomBytes(4).toString('hex')}`;
        
        // Create embeddings for the chunk
        const vector = await embeddings.embedQuery(chunk.pageContent);
        
        // Create enhanced metadata
        const chunkMetadata = {
          ...metadata,
          sourceId: id,
          chunkIndex: i,
          totalChunks: chunks.length,
          type: 'text',
          text: chunk.pageContent, // Store the original text in metadata
        };
        
        // Store vector in Pinecone
        await index.upsert([{
          id: chunkId,
          values: vector,
          metadata: chunkMetadata
        }]);
        
        // Store reference in database using Prisma
        const dbEntry = await prismaClient.documentChunk.create({
          data: {
            id: chunkId,
            content: chunk.pageContent,
            contentType: 'text',
            metadata: chunkMetadata,
            documentId: id, // Group chunks by original document ID
            embeddingId: chunkId, // Same as the Pinecone ID
          }
        });
        
        storedChunks.push(dbEntry);
      }
      
      return res.json({
        success: true,
        message: `Text processed and split into ${chunks.length} chunks`,
        chunks: storedChunks.length,
        documentId: id
      });
    } catch (error: any) {
      console.error("Error embedding text:", error);
      return res.status(500).json({ 
        success: false,
        error: error.message,
        message: "Internal Server Error" 
      });
    }
  }

  /**
   * Handle PDF file uploads
   * Processes the PDF, extracts text, splits into chunks, and embeds each chunk
   */
  async uploadPDF(req: Request, res: Response, pineconeClient: any) {
    try {
      // Check if file was uploaded
      if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }
      
      // Check if Pinecone client is initialized
      if (!pineconeClient) {
        return res.status(503).json({ error: "Database not yet initialized" });
      }
      
      // Extract metadata from the request body - handle potential parsing errors
      let metadata = {};
      try {
        metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
      } catch (parseError) {
        console.warn("Error parsing metadata JSON:", parseError);
        // Continue with empty metadata rather than failing the whole request
      }
      
      // Log file information for debugging
      console.log("Processing file:", {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });
      
      // Save the uploaded file temporarily
      const filePath = await pdfService.savePDFToDisk(
        req.file.buffer,
        req.file.originalname
      );
      
      // Process the PDF file
      const result = await pdfService.processPDF(filePath, pineconeClient, metadata);
      
      if (result.success) {
        return res.json(result);
      } else {
        return res.status(500).json(result);
      }
    } catch (error: any) {
      console.error("Error uploading PDF:", error);
      return res.status(500).json({ 
        success: false,
        error: error.message,
        message: "Failed to process PDF upload" 
      });
    }
  }
}