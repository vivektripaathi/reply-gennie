import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { google } from 'googleapis';
import { OpenaiService } from 'src/openai/openai.service';

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    private gmailClient;


    private labelMapping = {
        'Interested': 'Label_3035777443514222121',
        'Not interested': 'Label_5649682475137114370',
        'More information': 'Label_5331249162142973886',
    };


    constructor(
        @InjectQueue('emailQueue') private emailQueue: Queue,
        private readonly openaiService: OpenaiService
    ) {}


    initializeGmailClient(accessToken: string) {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: accessToken });
        this.gmailClient = google.gmail({
            version: 'v1',
            auth: oauth2Client,
        });
    }


    async scheduleEmailChecking() {
        await this.emailQueue.add('checkUnreadEmails', {}, {
            delay: 60000,
        });
    }


    async checkUnreadEmails() {
        try {
            if (!this.gmailClient) return;

            const res = await this.gmailClient.users.messages.list({
                userId: 'me',
                q: 'is:unread',
            });

            const messages = res.data.messages || [];
            for (const message of messages) {
                await this.emailQueue.add('processEmail', { messageId: message.id });
            }
        } catch (error) {
            this.logger.error('Error checking unread emails:', error.message);
        }
    }


    async getEmailData(messageId: string) {
        try {
            const res = await this.gmailClient.users.messages.get({
                userId: 'me',
                id: messageId,
            });

            const email = res.data;
            const headers = email.payload.headers;
            const subject = headers.find(header => header.name === 'Subject')?.value || 'No Subject';
            const from = headers.find(header => header.name === 'From')?.value || '';
            const to = headers.find(header => header.name === 'To')?.value || '';
            const emailContent = email.snippet || '';

            return { from, to, subject, emailContent };
        } catch (error) {
            this.logger.error(`Error fetching email data for message ID ${messageId}:`, error.message);
            return null;
        }
    }


    private async sendReplyEmail(messageId: string, emailData: { from: string; to: string, subject: string; text: string }) {
        try {
            const { from, to, subject, text } = emailData;

            const message = this.createReplyMessage(to, from, subject, text, messageId);

            const res = await this.gmailClient.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: message,
                },
            });

            this.logger.log(`Reply sent to: ${from}, message ID: ${res.data.id}`);
        } catch (error) {
            this.logger.error(`Error sending reply email:`, error.message);
        }
    }


    private createReplyMessage(from: string, to: string, subject: string, text: string, messageId: string): string {
        const messageParts = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: Re: ${subject}`,
            `In-Reply-To: ${messageId}`,
            `References: ${messageId}`,
            '',
            text,
        ];
    
        const message = messageParts.join('\n');
        const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return encodedMessage;
    }


    private async assignLabelToEmail(messageId: string, labelId: string) {
        try {
            await this.gmailClient.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: [labelId], // Adds the specified label
                },
            });
            this.logger.log(`Label ${labelId} assigned to email: ${messageId}`);
        } catch (error) {
            this.logger.error(`Error assigning label to email for message ID ${messageId}:`, error.message);
        }
    }


    private async markEmailAsRead(messageId: string) {
        try {
            await this.gmailClient.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    removeLabelIds: ['UNREAD'], // Removes the "UNREAD" label
                },
            });
            this.logger.log(`Email marked as read: ${messageId}`);
        } catch (error) {
            this.logger.error(`Error marking email as read for message ID ${messageId}:`, error.message);
        }
    }


    async processIncomingEmail(messageId: string, emailData: { from: string; to: string, subject: string; emailContent: string }) {
        try {
            const { from, to, subject, emailContent } = emailData;

            const emailContext = await this.openaiService.analyzeEmailContext(emailContent);
            this.logger.log('Email Context:', emailContext);

            const category = await this.openaiService.categorizeEmailContent(emailContent);
            this.logger.log('Email Category:', category);
            const labelId = this.labelMapping[category] || null;
            if (labelId) {
                await this.assignLabelToEmail(messageId, labelId); // Assign the label if it exists
            } else {
                this.logger.warn(`No label found for category: ${category}`);
            }

            const replyContent = await this.openaiService.generateEmailReply(emailContent);
            this.logger.log('Generated Reply:', replyContent);

            await this.sendReplyEmail(messageId, { from: from, to: to, subject: subject, text: replyContent });

            await this.markEmailAsRead(messageId);
        } catch (error) {
            this.logger.error('Error processing incoming email:', error.message);
        }
    }
}
