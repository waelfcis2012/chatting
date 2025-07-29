import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface RoomParticipant {
  id: string;
  socket: Socket;
}

@WebSocketGateway({ cors: true })
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private rooms: Map<string, RoomParticipant[]> = new Map();

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    client.emit('init', { id: client.id });
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    // Remove client from all rooms
    this.rooms.forEach((participants, roomId) => {
      const index = participants.findIndex(p => p.id === client.id);
      if (index !== -1) {
        participants.splice(index, 1);
        // Notify other participants in the room
        participants.forEach(participant => {
          participant.socket.emit('participantLeft', { participantId: client.id });
        });
        // Remove room if empty
        if (participants.length === 0) {
          this.rooms.delete(roomId);
        }
      }
    });
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { roomId: string }, @ConnectedSocket() client: Socket): void {
    const { roomId } = data;
    
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, []);
    }
    
    const room = this.rooms.get(roomId)!;
    const existingParticipant = room.find(p => p.id === client.id);
    
    if (!existingParticipant) {
      room.push({ id: client.id, socket: client });
      client.join(roomId);
      
      // Notify the joining client about existing participants
      const existingParticipants = room.filter(p => p.id !== client.id).map(p => p.id);
      client.emit('roomJoined', { 
        roomId, 
        participants: existingParticipants,
        myId: client.id 
      });
      
      // Notify other participants in the room about the new participant
      room.forEach(participant => {
        if (participant.id !== client.id) {
          participant.socket.emit('participantJoined', { participantId: client.id });
        }
      });
      
      console.log(`Client ${client.id} joined room ${roomId}. Total participants: ${room.length}`);
    }
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@MessageBody() data: { roomId: string }, @ConnectedSocket() client: Socket): void {
    const { roomId } = data;
    const room = this.rooms.get(roomId);
    
    if (room) {
      const index = room.findIndex(p => p.id === client.id);
      if (index !== -1) {
        room.splice(index, 1);
        client.leave(roomId);
        
        // Notify other participants
        room.forEach(participant => {
          participant.socket.emit('participantLeft', { participantId: client.id });
        });
        
        // Remove room if empty
        if (room.length === 0) {
          this.rooms.delete(roomId);
        }
        
        console.log(`Client ${client.id} left room ${roomId}. Remaining participants: ${room.length}`);
      }
    }
  }

  @SubscribeMessage('signal')
  handleSignal(@MessageBody() data: any, @ConnectedSocket() client: Socket): void {
    const { to, ...payload } = data;
    this.server.to(to).emit('signal', { from: client.id, ...payload });
  }

  @SubscribeMessage('roomSignal')
  handleRoomSignal(@MessageBody() data: any, @ConnectedSocket() client: Socket): void {
    const { roomId, to, ...payload } = data;
    const room = this.rooms.get(roomId);
    
    if (room) {
      if (to) {
        // Send to specific participant
        const targetParticipant = room.find(p => p.id === to);
        if (targetParticipant) {
          targetParticipant.socket.emit('roomSignal', { from: client.id, ...payload });
        }
      } else {
        // Send to all participants in the room except the sender
        room.forEach(participant => {
          if (participant.id !== client.id) {
            participant.socket.emit('roomSignal', { from: client.id, ...payload });
          }
        });
      }
    }
  }
}
